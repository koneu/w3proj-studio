// MDL (the text form of a Warcraft III model) reader: builds the same `Model` the MDX reader does (mdx.ts), so
// everything that draws an MDX draws an MDL unchanged.
//
// The text is a list of blocks: `Keyword ["name"] [counts] { entries }`, entries separated by commas, an entry being
// words, numbers, strings and nested blocks (`Interval { 0, 1000 }`), track keys as `time: value` with `InTan` and
// `OutTan` after them for Hermite and Bezier. Stated counts (`Vertices 3 {`) are not trusted: what is in the braces
// counts, so a damaged count can't make the reader allocate or wait. Nothing is read recursively beyond the format's
// own fixed depth, and unknown blocks are skipped by brace depth, so stray or unclosed braces end the file, not the app.
//
// What it reads matches mdx.ts: blocks the renderer depends on (geosets, materials, textures, sequences, bones,
// helpers, pivots, geoset animations) are read strictly and a fault in them refuses the model; in the others it
// becomes a warning and the block is left out.

import { parseMdx, type Extent, type Geoset, type GeosetAnim, type Interp, type Layer, type Material, type Model, type ModelLight, type Node, type ParticleEmitter2, type RibbonEmitter, type Sequence, type TextureAnim, type Track } from "./mdx";

const enum T { End, Open, Close, Comma, Colon, Str, Word }

/** MDL's block names to the MDX chunk tags `Model.skipped` uses (the terrain view looks for "CORN"). */
const SKIPPED_TAG: Record<string, string> = {
  Light: "LITE", ParticleEmitter: "PREM", ParticleEmitterPopcorn: "CORN", CollisionShape: "CLID", Camera: "CAMS", FaceFX: "FAFX", BindPose: "BPOS",
};
/** Blocks the renderer depends on: a fault refuses the model (as mdx.ts does for their chunks). */
const STRICT = new Set(["Geoset", "Materials", "Textures", "Sequences", "Bone", "Helper", "PivotPoints", "GeosetAnim"]);
const INTERP: Record<string, Interp> = { DontInterp: 0, Linear: 1, Hermite: 2, Bezier: 3 };
const FILTER: Record<string, number> = { None: 0, Transparent: 1, Blend: 2, Additive: 3, AddAlpha: 4, Modulate: 5, Modulate2x: 6 };
const SHADING: Record<string, number> = { Unshaded: 0x1, SphereEnvMap: 0x2, TwoSided: 0x10, Unfogged: 0x20, NoDepthTest: 0x40, NoDepthSet: 0x80 };
const MATERIAL_FLAGS: Record<string, number> = { ConstantColor: 0x1, SortPrimsNearZ: 0x8, SortPrimsFarZ: 0x10, FullResolution: 0x20 };
const NODE_FLAGS: Record<string, number> = { Billboarded: 0x8, BillboardedLockX: 0x10, BillboardedLockY: 0x20, BillboardedLockZ: 0x40, CameraAnchored: 0x80 };
const INHERIT: Record<string, number> = { Translation: 0x1, Rotation: 0x2, Scaling: 0x4 };
const PRE2_FLAGS: Record<string, number> = { Unshaded: 0x8000, SortPrimsFarZ: 0x10000, LineEmitter: 0x20000, Unfogged: 0x40000, ModelSpace: 0x80000, XYQuad: 0x100000 };
const PRE2_FILTER: Record<string, number> = { Blend: 0, Additive: 1, Modulate: 2, Modulate2x: 3, AlphaKey: 4 };
const HEAD_OR_TAIL: Record<string, number> = { Head: 0, Tail: 1, Both: 2 };
const LIGHT_TYPE: Record<string, number> = { Omnidirectional: 0, Directional: 1, Ambient: 2 };
/** More warnings than this say nothing new and only take memory. */
const MAX_WARNINGS = 100;

/** Does this look like MDL text rather than MDX bytes? (No MDLX tag, no zero bytes at the start.) */
export function isMdlText(buf: Uint8Array): boolean {
  if (buf.length >= 4 && buf[0] === 0x4d && buf[1] === 0x44 && buf[2] === 0x4c && buf[3] === 0x58) return false;
  return !buf.subarray(0, 4096).includes(0);
}

/** Reads a model file of either form, told apart by its content: MDX (binary, "MDLX") or MDL (text). */
export function parseModel(buf: Uint8Array): Model {
  if (!isMdlText(buf)) return parseMdx(buf);
  // A UTF-8 byte order mark (an editor's) would glue itself to the first word and hide a comment's start.
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return parseMdl(new TextDecoder("latin1").decode(bom ? buf.subarray(3) : buf));
}

/** Reads MDL text. Throws, with the line, when a block the renderer needs can't be read. */
export function parseMdl(text: string): Model {
  return new MdlReader(text).model();
}

const vec3 = (v: number[]): [number, number, number] => [v[0], v[1], v[2]];

class MdlReader {
  private p = 0;
  private line = 1;
  /** The current token. */
  private kind = T.End;
  private text = "";
  private tokLine = 1;
  private readonly warned = new Set<string>();
  private readonly m: Model;

  constructor(private readonly src: string) {
    this.m = {
      version: 800, name: "", extent: { radius: 0, min: [0, 0, 0], max: [0, 0, 0] },
      sequences: [], globalSequences: [], textures: [], materials: [], geosets: [], geosetAnims: [],
      nodes: [], pivots: new Float32Array(0), particleEmitters2: [], ribbons: [], textureAnims: [], skipped: [], warnings: [],
    };
    this.next();
  }

  // --- tokens ------------------------------------------------------------------------------

  private next() {
    const s = this.src, n = s.length;
    let p = this.p;
    for (;;) {
      while (p < n) {
        const c = s.charCodeAt(p);
        if (c === 10) { this.line++; p++; } else if (c <= 32) p++; else break;
      }
      // A comment runs to the end of its line.
      if (p + 1 < n && s.charCodeAt(p) === 47 && s.charCodeAt(p + 1) === 47) {
        const nl = s.indexOf("\n", p);
        p = nl < 0 ? n : nl;
        continue;
      }
      break;
    }
    this.tokLine = this.line;
    if (p >= n) { this.p = p; this.kind = T.End; this.text = ""; return; }
    const c = s[p];
    const single: Record<string, T> = { "{": T.Open, "}": T.Close, ",": T.Comma, ":": T.Colon };
    if (single[c] !== undefined) { this.p = p + 1; this.kind = single[c]; this.text = c; return; }
    if (c === "\"") {
      // Paths keep their backslashes as they are; a string ends at its quote, or (damaged) at the line's end.
      let e = p + 1;
      while (e < n && s[e] !== "\"" && s[e] !== "\n") e++;
      this.kind = T.Str;
      this.text = s.slice(p + 1, e);
      this.p = e < n && s[e] === "\"" ? e + 1 : e;
      return;
    }
    let e = p;
    while (e < n) {
      const d = s.charCodeAt(e);
      // whitespace { } , : "
      if (d <= 32 || d === 123 || d === 125 || d === 44 || d === 58 || d === 34) break;
      e++;
    }
    this.kind = T.Word;
    this.text = s.slice(p, e);
    this.p = e;
  }

  private at(kind: T) { return this.kind === kind; }
  private save() { return { p: this.p, line: this.line, kind: this.kind, text: this.text, tokLine: this.tokLine }; }
  private restore(st: ReturnType<MdlReader["save"]>) { Object.assign(this, st); }

  private fail(what: string): never {
    const found = this.kind === T.End ? "the end" : JSON.stringify(this.text.slice(0, 40));
    throw new Error(`line ${this.tokLine}: ${what}, found ${found}`);
  }
  private expect(kind: T, what: string) {
    if (this.kind !== kind) this.fail(`${what} expected`);
    this.next();
  }
  private warn(msg: string) {
    if (this.warned.has(msg) || this.warned.size >= MAX_WARNINGS) return;
    this.warned.add(msg);
    this.m.warnings.push(msg);
  }

  /** Skips the rest of an entry: up to its comma, or past its first block; stops before the closing brace of the
   *  block it is in. By depth, not recursion, and an unclosed brace just ends at the file's end. */
  private skipItem() {
    let depth = 0;
    for (;;) {
      switch (this.kind) {
        case T.End: return;
        case T.Open: depth++; break;
        case T.Close:
          if (depth === 0) return;
          if (--depth === 0) { this.next(); return; }
          break;
        case T.Comma: if (depth === 0) { this.next(); return; } break;
      }
      this.next();
    }
  }

  // --- values ------------------------------------------------------------------------------

  private num(): number {
    if (this.kind !== T.Word) this.fail("number expected");
    const t = this.text;
    let v = Number(t);
    if (Number.isNaN(v)) {
      // What some converters print for infinities and NaNs ("1.#INF", "-1.#IND").
      const odd = /^([-+]?)\d*\.?\d*#(INF|IND|QNAN|SNAN)/i.exec(t);
      if (!odd) this.fail("number expected");
      v = odd[2].toUpperCase() === "INF" ? (odd[1] === "-" ? -Infinity : Infinity) : NaN;
    }
    this.next();
    return v;
  }
  /** A float as the MDX file holds it (32 bits), so both forms of a model read alike. */
  private flt(): number { return Math.fround(this.num()); }
  private int(): number {
    const v = this.num();
    return Number.isFinite(v) ? Math.trunc(v) : 0;
  }
  private str(): string {
    if (this.kind !== T.Str) this.fail("string expected");
    const s = this.text;
    this.next();
    return s;
  }
  /** `{ n, n, … }`: its numbers appended to `out` (all of them; `size`: the first `size`, zeros for missing ones). */
  private vec(out: number[] = [], size = -1): number[] {
    this.expect(T.Open, "{");
    const from = out.length;
    for (;;) {
      if (this.kind === T.Close) { this.next(); break; }
      if (this.kind === T.Comma) { this.next(); continue; }
      const v = this.flt();
      if (size < 0 || out.length - from < size) out.push(v);
    }
    while (size >= 0 && out.length - from < size) out.push(0);
    return out;
  }
  /** A number or a `{ … }` of `size` numbers. */
  private value(size: number): number[] {
    if (this.kind === T.Open) return this.vec([], size);
    const out = [this.flt()];
    while (out.length < size) out.push(0);
    return out;
  }
  /** `{ {…}, {…} }` (or bare numbers): all numbers, flattened into `out`; each inner one gives `size` (if set). */
  private numbers(out: number[], size = -1) {
    this.expect(T.Open, "{");
    for (;;) {
      if (this.kind === T.Close) { this.next(); return out; }
      if (this.kind === T.Comma) { this.next(); continue; }
      if (this.kind === T.Open) this.vec(out, size);
      else out.push(this.flt());
    }
  }
  /** Counts stated before a block (`Vertices 3 {`): not trusted, skipped. */
  private counts() {
    while (this.kind === T.Word) this.next();
  }
  private extent(): Extent { return { radius: 0, min: [0, 0, 0], max: [0, 0, 0] }; }
  /** An extent's entry, if `key` is one. */
  private extentField(e: Extent, key: string): boolean {
    if (key === "MinimumExtent") e.min = vec3(this.value(3));
    else if (key === "MaximumExtent") e.max = vec3(this.value(3));
    else if (key === "BoundsRadius") e.radius = this.flt();
    else return false;
    return true;
  }

  /** A block of entries: `item` gets each entry's first word (`static` dropped) with the reader past it and says
   *  whether it knew it; an unknown one is warned about (`where`) and skipped. */
  private block(where: string, item: (key: string) => boolean) {
    this.expect(T.Open, "{");
    for (;;) {
      switch (this.kind) {
        case T.Close: this.next(); return;
        case T.End: return this.fail("} expected");
        case T.Comma: this.next(); continue;
        case T.Word: break;
        default: this.skipItem(); continue;
      }
      let key = this.text;
      this.next();
      if (key === "static" && this.kind === T.Word) { key = this.text; this.next(); }
      if (!item(key)) {
        this.warn(`${where}: ${key} not read`);
        this.skipItem();
      }
    }
  }

  /** A track: `count { Interp, [GlobalSeqId n,] time: value, [InTan value, OutTan value,] … }`, `size` numbers per value. */
  private track(size: number): Track {
    this.counts();
    this.expect(T.Open, "{");
    let interp: Interp = 0, globalSeq = -1;
    const times: number[] = [], values: number[] = [], inTan: number[] = [], outTan: number[] = [];
    for (;;) {
      if (this.kind === T.Close) { this.next(); break; }
      if (this.kind === T.Comma) { this.next(); continue; }
      if (this.kind !== T.Word) this.fail("track key expected");
      const w = this.text;
      if (INTERP[w] !== undefined) { interp = INTERP[w]; this.next(); }
      else if (w === "GlobalSeqId") { this.next(); globalSeq = this.int(); }
      else if (w === "InTan" || w === "OutTan") {
        this.next();
        const v = this.value(size), into = w === "InTan" ? inTan : outTan;
        if (times.length) for (let k = 0; k < size; k++) into[(times.length - 1) * size + k] = v[k];
      } else {
        const time = this.num();
        this.expect(T.Colon, ":");
        times.push(time);
        values.push(...this.value(size));
        for (let k = 0; k < size; k++) { inTan.push(0); outTan.push(0); }
      }
    }
    const tangents = interp > 1;
    return {
      interp, globalSeq, times: Uint32Array.from(times, (t) => (Number.isFinite(t) ? t : 0)), values: new Float32Array(values), size,
      inTan: tangents ? new Float32Array(inTan) : undefined, outTan: tangents ? new Float32Array(outTan) : undefined,
    };
  }
  /** After a property's name: a fixed value, or a track (`count { … }`). An animated property has no fixed value in
   *  the text: it is `dflt` then (what the binary holds beside a track, used where the track has no key), else the
   *  track's first key. */
  private prop(size: number, dflt?: number[]): { value: number[]; track?: Track } {
    if (this.kind === T.Open) return { value: this.vec([], size) };
    const n = this.num();
    // (Read through a method: the narrowing above doesn't know that num() moved on.)
    if (this.at(T.Open)) {
      const track = this.track(size);
      if (dflt) return { value: dflt.slice(0, size), track };
      const value = [...track.values.subarray(0, size)];
      while (value.length < size) value.push(0);
      return { value, track };
    }
    const value = [Math.fround(n)];
    while (value.length < size) value.push(0);
    return { value };
  }

  // --- blocks ------------------------------------------------------------------------------

  model(): Model {
    const m = this.m;
    // Text that isn't a model at all (an empty file, a readme renamed) is refused, as mdx.ts refuses a missing MDLX.
    const first = this.save();
    let known = false;
    for (let depth = 0; this.kind !== T.End && !known; this.next()) {
      if (this.kind === T.Open) depth++;
      else if (this.kind === T.Close) depth--;
      else if (depth === 0 && this.kind === T.Word && /^(Version|Model|Geoset|Sequences|Textures|Materials|Bone|Helper)$/.test(this.text)) known = true;
    }
    if (!known) throw new Error("not an MDL model (no Version, Model or Geoset block)");
    this.restore(first);
    while (this.kind !== T.End) {
      if (this.kind === T.Comma) { this.next(); continue; }
      if (this.kind !== T.Word) { this.warn(`line ${this.tokLine}: stray ${JSON.stringify(this.text)}`); this.next(); continue; }
      const at = this.save(), key = this.text;
      this.next();
      try {
        this.top(key);
      } catch (e) {
        if (STRICT.has(key)) throw new Error(`${key}: ${(e as Error).message}`);
        this.warn(`${key}: ${(e as Error).message}`);
        this.restore(at);
        this.next();
        this.skipItem();
      }
    }
    return m;
  }

  private skipped(tag: string) { if (!this.m.skipped.includes(tag)) this.m.skipped.push(tag); }

  private top(key: string) {
    const m = this.m;
    switch (key) {
      case "Version":
        this.block("Version", (k) => { if (k !== "FormatVersion") return false; m.version = this.int(); return true; });
        return;
      case "Model":
        if (this.kind === T.Str) m.name = this.str();
        this.block("Model", (k) => this.extentField(m.extent, k) || (/^(Num|BlendTime|AnimationFile)/.test(k) && (this.skipItem(), true)));
        return;
      case "Sequences":
        this.counts();
        this.block("Sequences", (k) => {
          if (k !== "Anim") return false;
          const s: Sequence = { name: this.kind === T.Str ? this.str() : "", start: 0, end: 0, moveSpeed: 0, flags: 0, rarity: 0, extent: this.extent() };
          this.block("Anim", (f) => {
            if (f === "Interval") { [s.start, s.end] = this.value(2).map((v) => (Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)); }
            else if (f === "NonLooping") s.flags |= 1;
            else if (f === "MoveSpeed") s.moveSpeed = this.flt();
            else if (f === "Rarity") s.rarity = this.flt();
            else return this.extentField(s.extent, f);
            return true;
          });
          m.sequences.push(s);
          return true;
        });
        return;
      case "GlobalSequences":
        this.counts();
        this.block("GlobalSequences", (k) => { if (k !== "Duration") return false; m.globalSequences.push(Math.max(0, this.int())); return true; });
        return;
      case "Textures":
        this.counts();
        this.block("Textures", (k) => {
          if (k !== "Bitmap") return false;
          const t = { replaceableId: 0, path: "", flags: 0 };
          this.block("Bitmap", (f) => {
            if (f === "Image") t.path = this.str();
            else if (f === "ReplaceableId") t.replaceableId = this.int();
            else if (f === "WrapWidth") t.flags |= 1;
            else if (f === "WrapHeight") t.flags |= 2;
            else return false;
            return true;
          });
          m.textures.push(t);
          return true;
        });
        return;
      case "Materials":
        this.counts();
        this.block("Materials", (k) => { if (k !== "Material") return false; m.materials.push(this.material()); return true; });
        return;
      case "TextureAnims":
        this.counts();
        this.block("TextureAnims", (k) => {
          if (k !== "TVertexAnim") return false;
          const a: TextureAnim = {};
          this.block("TVertexAnim", (f) => {
            if (f === "Translation") a.translation = this.prop(3).track;
            else if (f === "Rotation") a.rotation = this.prop(4).track;
            else if (f === "Scaling") a.scaling = this.prop(3).track;
            else return false;
            return true;
          });
          m.textureAnims.push(a);
          return true;
        });
        return;
      case "Geoset": m.geosets.push(this.geoset()); return;
      case "GeosetAnim": m.geosetAnims.push(this.geosetAnim()); return;
      case "PivotPoints": {
        this.counts();
        m.pivots = new Float32Array(this.numbers([], 3));
        return;
      }
      case "Bone": this.addNode(this.node("bone", 0x100)); return;
      case "Helper": this.addNode(this.node("helper", 0)); return;
      case "Attachment": this.addNode(this.node("atch", 0x800, (k) => k === "AttachmentID" || k === "Path" || k === "Visibility" ? (this.skipItem(), true) : false)); return;
      case "EventObject": this.addNode(this.node("event", 0x400, (k) => (k === "EventTrack" ? (this.skipItem(), true) : false))); return;
      case "ParticleEmitter":
        this.skipped("PREM");
        this.addNode(this.node("prem", 0x1000, (k, n) => {
          if (k === "EmitterUsesMDL") n.flags |= 0x8000;
          else if (k === "EmitterUsesTGA") n.flags |= 0x10000;
          else return false;
          return true;
        }, true));
        return;
      case "ParticleEmitterPopcorn":
        this.skipped("CORN");
        this.addNode(this.node("corn", 0, undefined, true));
        return;
      case "ParticleEmitter2": this.particleEmitter2(); return;
      case "RibbonEmitter": this.ribbon(); return;
      case "Light": this.light(); return;
      default:
        if (SKIPPED_TAG[key]) this.skipped(SKIPPED_TAG[key]);
        else { this.warn(`${key}: block not read`); this.skipped(key); }
        this.skipItem();
    }
  }

  private material(): Material {
    const mat: Material = { priorityPlane: 0, flags: 0, layers: [] };
    this.block("Material", (k) => {
      if (MATERIAL_FLAGS[k]) mat.flags |= MATERIAL_FLAGS[k];
      else if (k === "PriorityPlane") mat.priorityPlane = this.int();
      else if (k === "Shader" || k === "TwoSided") this.skipItem();
      else if (k === "Layer") mat.layers.push(this.layer());
      else return false;
      return true;
    });
    return mat;
  }

  private layer(): Layer {
    const l: Layer = { filterMode: 0, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 };
    let haveTexture = false;
    this.block("Layer", (k) => {
      if (k === "FilterMode") {
        if (this.kind !== T.Word || FILTER[this.text] === undefined) this.fail("filter mode expected");
        l.filterMode = FILTER[this.text];
        this.next();
      } else if (SHADING[k]) l.shadingFlags |= SHADING[k];
      else if (k === "TextureID") {
        const p = this.prop(1);
        // Reforged layers name a texture per slot; the first (the diffuse) is what is drawn.
        if (!haveTexture) { l.textureIds = [Math.trunc(p.value[0]) || 0]; if (p.track) l.textureTrack = p.track; haveTexture = true; }
      } else if (k === "Alpha") { const p = this.prop(1, [l.alpha]); l.alpha = p.value[0]; l.alphaTrack = p.track; }
      else if (k === "TVertexAnimId") l.textureAnimId = this.int();
      else if (k === "CoordId") l.coordId = this.int();
      else if (/^(EmissiveGain|Fresnel|Unlit|HD|Shader)/.test(k)) this.skipItem();
      else return false;
      return true;
    });
    return l;
  }

  private geoset(): Geoset {
    const positions: number[] = [], normals: number[] = [], groupsFlat: number[][] = [], faces: number[] = [], vertexGroups: number[] = [];
    const g: { materialId: number; lod: number; lodName: string; extent: Extent; uvs?: number[]; skin?: number[] } = { materialId: 0, lod: 0, lodName: "", extent: this.extent() };
    this.block("Geoset", (k) => {
      switch (k) {
        case "Vertices": this.counts(); this.numbers(positions, 3); break;
        case "Normals": this.counts(); this.numbers(normals, 3); break;
        case "TVertices": {
          this.counts();
          const set = this.numbers([], 2);
          g.uvs ??= set;
          break;
        }
        case "VertexGroup": this.counts(); this.numbers(vertexGroups); break;
        case "SkinWeights": this.counts(); g.skin = this.numbers([]); break;
        case "Faces":
          this.counts();
          this.block("Faces", (f) => {
            if (f !== "Triangles") this.fail(`unsupported primitive type ${f}`);
            this.numbers(faces);
            return true;
          });
          break;
        case "Groups":
          this.counts();
          this.block("Groups", (f) => {
            if (f !== "Matrices") return false;
            groupsFlat.push(this.numbers([]).map((v) => (Number.isFinite(v) ? Math.trunc(v) : 0)));
            return true;
          });
          break;
        case "MaterialID": g.materialId = this.int(); break;
        case "LevelOfDetail": g.lod = this.int(); break;
        case "Name": g.lodName = this.str(); break;
        case "Tangents": case "Anim": case "SelectionGroup": case "Unselectable": this.skipItem(); break;
        default: if (!this.extentField(g.extent, k)) return false;
      }
      return true;
    });
    if (positions.length % 3 || normals.length % 3) this.fail("vertices of three numbers expected");
    const vertices = positions.length / 3;
    const toU16 = (v: number) => (Number.isFinite(v) ? v & 0xffff : 0);
    const big = vertexGroups.some((v) => v > 255);
    let sk: Uint16Array | undefined;
    if (g.skin) {
      if (g.skin.length !== vertices * 8) throw new Error(`line ${this.tokLine}: SkinWeights of ${g.skin.length} numbers for ${vertices} vertices`);
      sk = Uint16Array.from(g.skin, toU16);
    }
    return {
      positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(g.uvs ?? []),
      faces: Uint16Array.from(faces, toU16), groups: groupsFlat, skin: sk, materialId: g.materialId, lod: g.lod, lodName: g.lodName, extent: g.extent,
      vertexGroups: vertexGroups.length === vertices ? (big ? Uint16Array.from(vertexGroups, toU16) : Uint8Array.from(vertexGroups, (v) => (Number.isFinite(v) ? v & 0xff : 0))) : new Uint8Array(vertices),
    };
  }

  private geosetAnim(): GeosetAnim {
    const a: GeosetAnim = { geosetId: 0, alpha: 1, color: [1, 1, 1] };
    this.block("GeosetAnim", (k) => {
      if (k === "Alpha") { const p = this.prop(1, [a.alpha]); a.alpha = p.value[0]; a.alphaTrack = p.track; }
      else if (k === "Color") { const p = this.prop(3, a.color); a.color = vec3(p.value); a.colorTrack = p.track; }
      else if (k === "GeosetId") a.geosetId = this.int();
      else if (k === "DropShadow" || k === "UseColor") this.skipItem();
      else return false;
      return true;
    });
    return a;
  }

  /** A node block (name, then entries); `own` reads the kind's own entries first, then the node's are read;
   *  `skipRest`: other entries are the kind's too (not drawn here), skipped without a warning. */
  private node(kind: string, typeFlag: number, own?: (key: string, n: Node) => boolean, skipRest = false): Node {
    const n: Node = { name: this.kind === T.Str ? this.str() : "", objectId: -1, parentId: -1, flags: typeFlag, kind };
    this.block(kind, (k) => (own?.(k, n) ?? false) || this.nodeField(n, k) || (skipRest && (this.skipItem(), true)));
    return n;
  }

  private nodeField(n: Node, key: string): boolean {
    if (NODE_FLAGS[key]) n.flags |= NODE_FLAGS[key];
    else if (key === "ObjectId") n.objectId = this.int();
    else if (key === "Parent") n.parentId = this.int();
    else if (key === "DontInherit") {
      this.block("DontInherit", (f) => { if (!INHERIT[f]) return false; n.flags |= INHERIT[f]; return true; });
    } else if (key === "Translation") n.translation = this.prop(3).track;
    else if (key === "Rotation") n.rotation = this.prop(4).track;
    else if (key === "Scaling") n.scaling = this.prop(3).track;
    else if (key === "GeosetId" || key === "GeosetAnimId" || key === "Visibility") this.skipItem();
    else return false;
    return true;
  }

  /** The ids count the nodes; `nodes` is indexed by them and walked by the renderer, so a huge one is refused (as in mdx.ts). */
  private addNode(n: Node) {
    if (n.objectId < 0) n.objectId = this.m.nodes.length;
    if (n.objectId >= this.src.length) throw new Error(`node id ${n.objectId}`);
    this.m.nodes[n.objectId] = n;
  }

  private particleEmitter2() {
    const e: Omit<ParticleEmitter2, "node"> = {
      speed: 0, variation: 0, latitude: 0, gravity: 0, lifespan: 0, emissionRate: 0, width: 0, length: 0, filterMode: 0, rows: 1, columns: 1,
      headOrTail: 0, tailLength: 0, time: 0.5, segmentColor: [[1, 1, 1], [1, 1, 1], [1, 1, 1]], segmentAlpha: [255, 255, 255], segmentScaling: [1, 1, 1],
      headIntervals: [0, 0, 1], headDecayIntervals: [0, 0, 1], tailIntervals: [0, 0, 1], tailDecayIntervals: [0, 0, 1],
      textureId: 0, squirt: false, priorityPlane: 0, replaceableId: 0,
    };
    const animated: Record<string, [keyof typeof e, keyof typeof e]> = {
      Speed: ["speed", "speedTrack"], Variation: ["variation", "variationTrack"], Latitude: ["latitude", "latitudeTrack"], Gravity: ["gravity", "gravityTrack"],
      EmissionRate: ["emissionRate", "emissionRateTrack"], Width: ["width", "widthTrack"], Length: ["length", "lengthTrack"],
    };
    const plain: Record<string, keyof typeof e> = {
      Rows: "rows", Columns: "columns", TextureID: "textureId", Time: "time", LifeSpan: "lifespan", TailLength: "tailLength",
      PriorityPlane: "priorityPlane", ReplaceableId: "replaceableId",
    };
    const intervals: Record<string, keyof typeof e> = {
      LifeSpanUVAnim: "headIntervals", DecayUVAnim: "headDecayIntervals", TailUVAnim: "tailIntervals", TailDecayUVAnim: "tailDecayIntervals",
    };
    const w = e as unknown as Record<string, unknown>;
    const node = this.node("pre2", 0x1000, (k, n) => {
      if (animated[k]) { const p = this.prop(1, [w[animated[k][0]] as number]); w[animated[k][0]] = p.value[0]; if (p.track) w[animated[k][1]] = p.track; }
      else if (k === "Visibility") e.visibilityTrack = this.prop(1).track;
      else if (plain[k]) w[plain[k]] = this.flt();
      else if (intervals[k]) w[intervals[k]] = vec3(this.value(3));
      else if (k === "Alpha") e.segmentAlpha = vec3(this.value(3));
      else if (k === "ParticleScaling") e.segmentScaling = vec3(this.value(3));
      else if (k === "SegmentColor") {
        const colors: [number, number, number][] = [];
        this.block("SegmentColor", (f) => { if (f !== "Color") return false; colors.push(vec3(this.value(3))); return true; });
        while (colors.length < 3) colors.push([1, 1, 1]);
        e.segmentColor = colors.slice(0, 3);
      } else if (HEAD_OR_TAIL[k] !== undefined) e.headOrTail = HEAD_OR_TAIL[k];
      else if (PRE2_FILTER[k] !== undefined) e.filterMode = PRE2_FILTER[k];
      else if (PRE2_FLAGS[k]) n.flags |= PRE2_FLAGS[k];
      else if (k === "Squirt") e.squirt = true;
      else return false;
      return true;
    });
    this.addNode(node);
    this.m.particleEmitters2.push({ node, ...e });
  }

  private ribbon() {
    const e: Omit<RibbonEmitter, "node"> = {
      heightAbove: 0, heightBelow: 0, alpha: 1, color: [1, 1, 1], lifespan: 0, textureSlot: 0, emissionRate: 0, rows: 1, columns: 1, materialId: 0, gravity: 0,
    };
    const node = this.node("ribb", 0x4000, (k) => {
      if (k === "HeightAbove") { const p = this.prop(1, [e.heightAbove]); e.heightAbove = p.value[0]; e.heightAboveTrack = p.track; }
      else if (k === "HeightBelow") { const p = this.prop(1, [e.heightBelow]); e.heightBelow = p.value[0]; e.heightBelowTrack = p.track; }
      else if (k === "Alpha") { const p = this.prop(1, [e.alpha]); e.alpha = p.value[0]; e.alphaTrack = p.track; }
      else if (k === "Color") { const p = this.prop(3, e.color); e.color = vec3(p.value); e.colorTrack = p.track; }
      else if (k === "TextureSlot") { const p = this.prop(1, [e.textureSlot]); e.textureSlot = Math.trunc(p.value[0]) || 0; e.textureSlotTrack = p.track; }
      else if (k === "Visibility") e.visibilityTrack = this.prop(1).track;
      else if (k === "EmissionRate") e.emissionRate = this.num();
      else if (k === "LifeSpan") e.lifespan = this.flt();
      else if (k === "Gravity") e.gravity = this.flt();
      else if (k === "Rows") e.rows = this.int();
      else if (k === "Columns") e.columns = this.int();
      else if (k === "MaterialID") e.materialId = this.int();
      else return false;
      return true;
    });
    this.addNode(node);
    this.m.ribbons.push({ node, ...e });
  }

  private light() {
    this.skipped("LITE");
    let type = 0, attenuationStart = 0, attenuationEnd = 0;
    const node = this.node("lite", 0x200, (k) => {
      if (LIGHT_TYPE[k] !== undefined) type = LIGHT_TYPE[k];
      else if (k === "AttenuationStart") attenuationStart = this.prop(1).value[0];
      else if (k === "AttenuationEnd") attenuationEnd = this.prop(1).value[0];
      else return false;
      return true;
    }, true);
    this.addNode(node);
    // As mdx.ts: a light whose reach makes no sense is left out; its node stays.
    const ok = (v: number) => Number.isFinite(v) && v >= 0 && v < 1e7;
    if (ok(attenuationStart) && ok(attenuationEnd)) {
      const light: ModelLight = { node, type, attenuationStart, attenuationEnd };
      (this.m.lights ??= []).push(light);
    }
  }
}
