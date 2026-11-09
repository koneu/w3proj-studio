// Day/night lighting models (Environment\DNC\…, and the copies the lighting editor of World
// Editor 3.0.1 saves into maps as "<guid>.mdl"): a model that holds only lights.
//
// Read from the game's binary .mdx and from .mdl text, written as .mdl text the way the World
// Editor writes it (same blocks, order and number format), so a model it saved comes back
// unchanged. MDX layout (version 1800): VERS, MODL, SEQS, GLBS, LITE, PIVT (HD versions add BPOS,
// not handled: the editor copies the classic models). A light is its node (name, ids, flags,
// translation/rotation/scaling tracks), then type, an unknown u32, attenuation start/end, colour,
// intensity, ambient colour and intensity, shadow intensity, shadow casting start/end, quadratic
// and linear falloff, damping (72 bytes), then its tracks (KLAS, KLAE, KLAC, KLAI, KLBC, KLBI, KLAV).

export type Vec = number[];

/** 0 none (DontInterp), 1 linear, 2 Hermite, 3 Bezier. */
export interface Key { time: number; value: Vec; inTan?: Vec; outTan?: Vec }
export interface Track { interp: number; globalSeq: number; keys: Key[] }
/** A value that is either fixed or animated. */
export type Prop = { value: Vec } | { track: Track };

export interface Light {
  name: string;
  objectId: number;
  parentId: number;
  flags: number;
  /** 0 omnidirectional, 1 directional, 2 ambient. */
  type: number;
  /** The u32 after the type (0 in every model seen); not in MDL text. */
  unknown: number;
  attenuationStart: Prop;
  attenuationEnd: Prop;
  intensity: Prop;
  color: Prop;
  ambIntensity: Prop;
  ambColor: Prop;
  shadowIntensity: number;
  shadowCastingStart: number;
  shadowCastingEnd: number;
  quadraticFalloff: number;
  linearFalloff: number;
  damping: number;
  visibility?: Track;
  translation?: Track;
  rotation?: Track;
  scaling?: Track;
}

export interface Sequence { name: string; start: number; end: number; moveSpeed: number; nonLooping: boolean; rarity: number }

export interface LightModel {
  version: number;
  name: string;
  blendTime: number;
  sequences: Sequence[];
  globalSequences: number[];
  lights: Light[];
  pivots: Vec[];
}

const INTERP = ["DontInterp", "Linear", "Hermite", "Bezier"];
const TYPES = ["Omnidirectional", "Directional", "Ambient"];
const LIGHT_TRACKS: [string, keyof Light, number][] = [
  ["KLAS", "attenuationStart", 1], ["KLAE", "attenuationEnd", 1], ["KLAC", "color", 3],
  ["KLAI", "intensity", 1], ["KLBC", "ambColor", 3], ["KLBI", "ambIntensity", 1], ["KLAV", "visibility", 1],
];
const NODE_TRACKS: [string, "translation" | "rotation" | "scaling", number][] = [["KGTR", "translation", 3], ["KGRT", "rotation", 4], ["KGSC", "scaling", 3]];

// ---- MDX ---------------------------------------------------------------------------------

class Reader {
  dv: DataView;
  constructor(public b: Uint8Array, public p = 0) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  floats(n: number) { return Array.from({ length: n }, () => this.f32()); }
  tag() { const s = String.fromCharCode(...this.b.subarray(this.p, this.p + 4)); return s; }
  str(n: number) {
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    const end = s.indexOf(0);
    return new TextDecoder().decode(end < 0 ? s : s.subarray(0, end));
  }
  track(width: number): Track {
    this.p += 4; // tag
    const n = this.u32(), interp = this.u32(), globalSeq = this.i32();
    const keys: Key[] = [];
    for (let i = 0; i < n; i++) {
      const key: Key = { time: this.i32(), value: this.floats(width) };
      if (interp > 1) { key.inTan = this.floats(width); key.outTan = this.floats(width); }
      keys.push(key);
    }
    return { interp, globalSeq, keys };
  }
}

/** Reads a lighting model from .mdx bytes. Throws for anything that isn't one. */
export function readLightMdx(buf: Uint8Array): LightModel {
  const r = new Reader(buf);
  if (r.tag() !== "MDLX") throw new Error("not an MDX model");
  r.p = 4;
  const m: LightModel = { version: 0, name: "", blendTime: 0, sequences: [], globalSequences: [], lights: [], pivots: [] };
  while (r.p < buf.length) {
    const tag = r.tag();
    r.p += 4;
    const size = r.u32(), end = r.p + size;
    if (tag === "VERS") m.version = r.u32();
    else if (tag === "MODL") {
      m.name = r.str(80);
      r.p += 260 + 28; // animation file, extents
      m.blendTime = r.u32();
    } else if (tag === "SEQS") {
      while (r.p < end) {
        const name = r.str(80), start = r.u32(), stop = r.u32(), moveSpeed = r.f32(), flags = r.u32(), rarity = r.f32();
        r.p += 4 + 28; // sync point, extents
        m.sequences.push({ name, start, end: stop, moveSpeed, nonLooping: (flags & 1) !== 0, rarity });
      }
    } else if (tag === "GLBS") {
      while (r.p < end) m.globalSequences.push(r.u32());
    } else if (tag === "PIVT") {
      while (r.p < end) m.pivots.push(r.floats(3));
    } else if (tag === "LITE") {
      while (r.p < end) {
        const lightEnd = r.p + r.u32();
        const nodeEnd = r.p + r.u32();
        const name = r.str(80), objectId = r.i32(), parentId = r.i32(), flags = r.u32();
        const node: Partial<Light> = {};
        while (r.p < nodeEnd) {
          const t = NODE_TRACKS.find(([k]) => k === r.tag());
          if (!t) throw new Error(`unknown node track ${r.tag()}`);
          node[t[1]] = r.track(t[2]);
        }
        const fixed = (v: number) => ({ value: [v] });
        const type = r.u32(), unknown = r.u32();
        const light: Light = {
          name, objectId, parentId, flags, type, unknown,
          attenuationStart: fixed(r.f32()), attenuationEnd: fixed(r.f32()),
          color: { value: r.floats(3) }, intensity: fixed(r.f32()),
          ambColor: { value: r.floats(3) }, ambIntensity: fixed(r.f32()),
          shadowIntensity: r.f32(), shadowCastingStart: r.f32(), shadowCastingEnd: r.f32(),
          quadraticFalloff: r.f32(), linearFalloff: r.f32(), damping: r.f32(),
          ...node,
        };
        while (r.p < lightEnd) {
          const t = LIGHT_TRACKS.find(([k]) => k === r.tag());
          if (!t) throw new Error(`unknown light track ${r.tag()}`);
          const track = r.track(t[2]);
          if (t[1] === "visibility") light.visibility = track;
          else (light as unknown as Record<string, Prop>)[t[1]] = { track };
        }
        m.lights.push(light);
      }
    } else if (tag !== "BPOS") {
      throw new Error(`not a lighting model (has ${tag})`);
    }
    r.p = end;
  }
  return m;
}

// ---- MDL text ----------------------------------------------------------------------------

/** A float32 the way C's %g prints it (6 significant digits, 3-digit exponent as on Windows). */
export function fmt(v: number): string {
  if (Object.is(v, -0)) return "-0";
  if (v === 0) return "0";
  const [mant, expStr] = v.toExponential(5).split("e");
  const exp = Number(expStr);
  const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= 6) return `${trim(mant)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(3, "0")}`;
  return trim(v.toFixed(Math.max(0, 5 - exp)));
}

/** C's ctime(): "Wed Nov  4 15:17:03 2026". */
function ctime(d: Date): string {
  const [day, mon] = d.toDateString().split(" ");
  return `${day} ${mon} ${String(d.getDate()).padStart(2, " ")} ${d.toTimeString().slice(0, 8)} ${d.getFullYear()}`;
}

const vec = (v: Vec) => (v.length === 1 ? fmt(v[0]) : `{ ${v.map(fmt).join(", ")} }`);

function writeTrack(out: string[], indent: string, name: string, t: Track) {
  out.push(`${indent}${name} ${t.keys.length} {`, `${indent}\t${INTERP[t.interp] ?? "DontInterp"},`);
  if (t.globalSeq >= 0) out.push(`${indent}\tGlobalSeqId ${t.globalSeq},`);
  for (const k of t.keys) {
    out.push(`${indent}\t${k.time}: ${vec(k.value)},`);
    if (t.interp > 1) out.push(`${indent}\t\tInTan ${vec(k.inTan!)},`, `${indent}\t\tOutTan ${vec(k.outTan!)},`);
  }
  out.push(`${indent}}`);
}

function writeProp(out: string[], name: string, p: Prop) {
  if ("track" in p) writeTrack(out, "\t", name, p.track);
  else out.push(`\tstatic ${name} ${vec(p.value)},`);
}

/** The model as .mdl text. `exported`: the second comment line's date (the World Editor's style). */
export function writeLightMdl(m: LightModel, exported = new Date()): string {
  const out = [
    "// MDLFile version\tW3Proj Studio",
    `// Exported on ${ctime(exported)}`,
    "Version {", `\tFormatVersion ${m.version},`, "}",
    `Model "${m.name}" {`, `\tNumLights ${m.lights.length},`, `\tBlendTime ${m.blendTime},`, "}",
  ];
  out.push(`Sequences ${m.sequences.length} {`);
  for (const s of m.sequences) {
    out.push(`\tAnim "${s.name}" {`, `\t\tInterval { ${s.start}, ${s.end} },`);
    if (s.nonLooping) out.push("\t\tNonLooping,");
    if (s.moveSpeed) out.push(`\t\tMoveSpeed ${fmt(s.moveSpeed)},`);
    if (s.rarity) out.push(`\t\tRarity ${fmt(s.rarity)},`);
    out.push("\t}");
  }
  out.push("}");
  if (m.globalSequences.length) {
    out.push(`GlobalSequences ${m.globalSequences.length} {`, ...m.globalSequences.map((d) => `\tDuration ${d},`), "}");
  }
  for (const l of m.lights) {
    out.push(`Light "${l.name}" {`, `\t${TYPES[l.type] ?? "Omnidirectional"},`);
    writeProp(out, "AttenuationStart", l.attenuationStart);
    writeProp(out, "AttenuationEnd", l.attenuationEnd);
    writeProp(out, "Intensity", l.intensity);
    writeProp(out, "Color", l.color);
    writeProp(out, "AmbIntensity", l.ambIntensity);
    writeProp(out, "AmbColor", l.ambColor);
    out.push(`\tstatic ShadowIntensity ${fmt(l.shadowIntensity)},`, `\tstatic ShadowCastingStart ${fmt(l.shadowCastingStart)},`,
      `\tstatic ShadowCastingEnd ${fmt(l.shadowCastingEnd)},`, `\tstatic QuadraticFalloff ${fmt(l.quadraticFalloff)},`,
      `\tstatic LinearFalloff ${fmt(l.linearFalloff)},`, `\tstatic Damping ${fmt(l.damping)},`);
    if (l.visibility) writeTrack(out, "\t", "Visibility", l.visibility);
    if (l.translation) writeTrack(out, "\t", "Translation", l.translation);
    if (l.rotation) writeTrack(out, "\t", "Rotation", l.rotation);
    if (l.scaling) writeTrack(out, "\t", "Scaling", l.scaling);
    out.push("}");
  }
  out.push(`PivotPoints ${m.pivots.length} {`, ...m.pivots.map((p) => `\t${vec(p)},`), "}");
  return out.join("\r\n") + "\r\n";
}

/** Reads the .mdl text of a lighting model (as written by the World Editor or writeLightMdl). */
export function readLightMdl(text: string): LightModel {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean);
  let i = 0;
  const fail = (what: string): never => { throw new Error(`MDL line ${i + 1}: ${what} ("${lines[i] ?? "end"}")`); };
  const nums = (s: string) => (s.match(/-?[\d.]+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  const block = (opener: RegExp) => { const m = opener.exec(lines[i]) ?? fail("unexpected"); i++; return m; };
  const m: LightModel = { version: 0, name: "", blendTime: 0, sequences: [], globalSequences: [], lights: [], pivots: [] };
  const readTrack = (): Track => {
    const t: Track = { interp: Math.max(0, INTERP.indexOf(lines[i++].replace(/,$/, ""))), globalSeq: -1, keys: [] };
    if (/^GlobalSeqId/.test(lines[i])) t.globalSeq = nums(lines[i++])[0];
    while (lines[i] !== "}") {
      const km = /^(-?\d+):\s*(.*),$/.exec(lines[i]) ?? fail("key expected");
      i++;
      const key: Key = { time: Number(km[1]), value: nums(km[2]) };
      if (t.interp > 1) {
        key.inTan = nums(/^InTan (.*),$/.exec(lines[i++])?.[1] ?? fail("InTan expected"));
        key.outTan = nums(/^OutTan (.*),$/.exec(lines[i++])?.[1] ?? fail("OutTan expected"));
      }
      t.keys.push(key);
    }
    i++;
    return t;
  };
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("Version")) { i++; m.version = nums(lines[i++])[0]; i++; }
    else if (l.startsWith("Model")) {
      m.name = block(/^Model "(.*)" \{$/)[1];
      while (lines[i] !== "}") { if (lines[i].startsWith("BlendTime")) m.blendTime = nums(lines[i])[0]; i++; }
      i++;
    } else if (l.startsWith("Sequences")) {
      i++;
      while (lines[i] !== "}") {
        const s: Sequence = { name: block(/^Anim "(.*)" \{$/)[1], start: 0, end: 0, moveSpeed: 0, nonLooping: false, rarity: 0 };
        while (lines[i] !== "}") {
          const v = nums(lines[i]);
          if (lines[i].startsWith("Interval")) [s.start, s.end] = v;
          else if (lines[i].startsWith("NonLooping")) s.nonLooping = true;
          else if (lines[i].startsWith("MoveSpeed")) s.moveSpeed = v[0];
          else if (lines[i].startsWith("Rarity")) s.rarity = v[0];
          i++;
        }
        i++;
        m.sequences.push(s);
      }
      i++;
    } else if (l.startsWith("GlobalSequences")) {
      i++;
      while (lines[i] !== "}") m.globalSequences.push(nums(lines[i++])[0]);
      i++;
    } else if (l.startsWith("PivotPoints")) {
      i++;
      while (lines[i] !== "}") m.pivots.push(nums(lines[i++]));
      i++;
    } else if (l.startsWith("Light")) {
      const light: Light = {
        name: block(/^Light "(.*)" \{$/)[1], objectId: m.lights.length, parentId: -1, flags: 0x200, type: 0, unknown: 0,
        attenuationStart: { value: [0] }, attenuationEnd: { value: [0] }, intensity: { value: [0] }, color: { value: [1, 1, 1] },
        ambIntensity: { value: [0] }, ambColor: { value: [1, 1, 1] }, shadowIntensity: 0, shadowCastingStart: 0, shadowCastingEnd: 0,
        quadraticFalloff: 0, linearFalloff: 0, damping: 0,
      };
      const props: Record<string, keyof Light> = {
        AttenuationStart: "attenuationStart", AttenuationEnd: "attenuationEnd", Intensity: "intensity", Color: "color",
        AmbIntensity: "ambIntensity", AmbColor: "ambColor",
      };
      const plain: Record<string, keyof Light> = {
        ShadowIntensity: "shadowIntensity", ShadowCastingStart: "shadowCastingStart", ShadowCastingEnd: "shadowCastingEnd",
        QuadraticFalloff: "quadraticFalloff", LinearFalloff: "linearFalloff", Damping: "damping",
      };
      const nodeTracks: Record<string, "translation" | "rotation" | "scaling" | "visibility"> = {
        Translation: "translation", Rotation: "rotation", Scaling: "scaling", Visibility: "visibility",
      };
      while (lines[i] !== "}") {
        const cur = lines[i];
        const type = TYPES.indexOf(cur.replace(/,$/, ""));
        const st = /^static (\w+) (.*),$/.exec(cur);
        const tr = /^(\w+) \d+ \{$/.exec(cur);
        if (type >= 0) { light.type = type; i++; }
        else if (st && props[st[1]]) { (light as unknown as Record<string, Prop>)[props[st[1]]] = { value: nums(st[2]) }; i++; }
        else if (st && plain[st[1]]) { (light as unknown as Record<string, number>)[plain[st[1]]] = nums(st[2])[0]; i++; }
        else if (tr && props[tr[1]]) { i++; (light as unknown as Record<string, Prop>)[props[tr[1]]] = { track: readTrack() }; }
        else if (tr && nodeTracks[tr[1]]) { i++; light[nodeTracks[tr[1]]] = readTrack(); }
        else fail("unknown light entry");
      }
      i++;
      m.lights.push(light);
    } else fail("unknown block");
  }
  return m;
}

// ---- lighting at a time of day ----------------------------------------------------------

/** Light for shading: `dir` points toward the light; colours are RGB, already scaled by intensity. */
export interface SceneLight {
  dir: [number, number, number];
  diffuse: [number, number, number];
  ambient: [number, number, number];
  /** The light's shadow intensity (HD shading uses it, see tone.ts hdLight); absent: 0. */
  shadow?: number;
  /** The share of the lit light the HD view keeps in its real shadows besides what the light itself gives there
   *  (tone.ts GAME_LIGHT_FILL: the game's own HD lighting); absent: 0. */
  fill?: number;
}

/** A track's value at `time` (keys in order; Hermite/Bezier use their tangents). */
export function sampleTrack(t: Track, time: number): Vec {
  const keys = t.keys;
  if (!keys.length) return [];
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].time <= time) i++;
  const a = keys[i], b = keys[i + 1];
  if (t.interp === 0 || b.time === a.time) return a.value;
  const u = (time - a.time) / (b.time - a.time);
  if (t.interp === 1 || !a.outTan || !b.inTan) return a.value.map((v, k) => v + (b.value[k] - v) * u);
  if (t.interp === 2) {
    const u2 = u * u, u3 = u2 * u;
    const h1 = 2 * u3 - 3 * u2 + 1, h2 = -2 * u3 + 3 * u2, h3 = u3 - 2 * u2 + u, h4 = u3 - u2;
    return a.value.map((v, k) => h1 * v + h2 * b.value[k] + h3 * a.outTan![k] + h4 * b.inTan![k]);
  }
  const iu = 1 - u;
  return a.value.map((v, k) => iu * iu * iu * v + 3 * iu * iu * u * a.outTan![k] + 3 * iu * u * u * b.inTan![k] + u * u * u * b.value[k]);
}

/** A track at the day's `time`. A track of a global sequence doesn't follow the day: it runs on its
 *  own clock (the game's models give the sun's rotation global sequence 0, 0 long), and the World
 *  Editor shows it at that clock's start, time 0, so its first key: a map whose lighting has a
 *  second rotation key later in the day still gets the first one (checked in the editor by moving
 *  that key to 400 and by swapping the two keys, 2026-11-08). */
const trackAt = (t: Track, time: number): Vec => sampleTrack(t, t.globalSeq >= 0 ? 0 : time);

const propAt = (p: Prop, time: number): Vec => ("track" in p ? trackAt(p.track, time) : p.value);

/** The model's first directional light at `hour` (0–24 over its first sequence, the game day).
 *  Colours are stored BGR (night is blue). The direction is the light's +Z axis turned by its
 *  rotation (the classic models: from the south-west, about 38° up, all day). Null without a
 *  directional light. */
export function lightAt(m: LightModel, hour: number): SceneLight | null {
  const l = m.lights.find((x) => x.type === 1) ?? m.lights[0];
  if (!l) return null;
  const seq = m.sequences[0] ?? { start: 0, end: 60000 };
  const time = seq.start + (((hour % 24) + 24) % 24 / 24) * (seq.end - seq.start);
  const rgb = (bgr: Vec, k: number): [number, number, number] => [(bgr[2] ?? 1) * k, (bgr[1] ?? 1) * k, (bgr[0] ?? 1) * k];
  const q = l.rotation ? trackAt(l.rotation, time) : [0, 0, 0, 1];
  const [x, y, z, w] = q.length === 4 ? q : [0, 0, 0, 1];
  // +Z rotated by q: the third column of the rotation matrix.
  const dir: [number, number, number] = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  return {
    dir,
    diffuse: rgb(propAt(l.color, time), propAt(l.intensity, time)[0] ?? 1),
    ambient: rgb(propAt(l.ambColor, time), propAt(l.ambIntensity, time)[0] ?? 0),
    shadow: l.shadowIntensity,
  };
}
