// A Reforged model (MDX 1000/1100/1800) written as a Classic one (MDX 800), so Classic graphics
// can draw it: the full-detail geometry, bones (Reforged skin weights become matrix groups),
// sequences, geoset and texture animations, one layer per material with its colour texture.
// Left out: normal/ORM/emissive/environment maps, team colour masks, PopcornFX (CORN), lights
// and events (they become helpers so object ids and the hierarchy stay), collision shapes,
// cameras, lower levels of detail. Units lose their team colour.

import type { Geoset, Model, Track } from "./mdx";

const TAG = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** Tracks stored as integers (texture ids). */
const INT_TRACKS = new Set(["KMTF"]);

class Writer {
  private parts: Uint8Array[] = [];
  private cur: number[] = [];
  private dv = new DataView(new ArrayBuffer(4));
  private flush() { if (this.cur.length) { this.parts.push(Uint8Array.from(this.cur)); this.cur = []; } }
  bytes(b: ArrayLike<number>) { this.flush(); this.parts.push(Uint8Array.from(b)); }
  tag(s: string) { this.cur.push(...TAG(s)); }
  u32(v: number) { this.dv.setUint32(0, v >>> 0, true); this.cur.push(...new Uint8Array(this.dv.buffer)); }
  i32(v: number) { this.dv.setInt32(0, v, true); this.cur.push(...new Uint8Array(this.dv.buffer)); }
  f32(v: number) { this.dv.setFloat32(0, v, true); this.cur.push(...new Uint8Array(this.dv.buffer)); }
  str(s: string, n: number) { const b = new Uint8Array(n); b.set(new TextEncoder().encode(s).subarray(0, n - 1)); this.cur.push(...b); }
  u8(v: number) { this.cur.push(v & 255); }
  /** The bytes written since `fn` started, prefixed by their size (+4 when `inclusive`). */
  sized(fn: () => void, inclusive: boolean) {
    this.flush();
    const outer = this.parts;
    this.parts = [];
    fn();
    this.flush();
    const inner = this.parts;
    this.parts = outer;
    const size = inner.reduce((n, p) => n + p.length, 0);
    this.u32(size + (inclusive ? 4 : 0));
    this.flush();
    this.parts.push(...inner);
  }
  chunk(tag: string, fn: () => void) { this.tag(tag); this.sized(fn, false); }
  done(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function track(w: Writer, tag: string, t: Track | undefined, map?: (v: number) => number) {
  if (!t) return;
  w.tag(tag);
  w.u32(t.times.length);
  w.u32(t.interp);
  w.i32(t.globalSeq);
  const val = (v: number) => (INT_TRACKS.has(tag) ? w.u32(map ? map(v) : v) : w.f32(v));
  for (let i = 0; i < t.times.length; i++) {
    w.u32(t.times[i]);
    for (let k = 0; k < t.size; k++) val(t.values[i * t.size + k]);
    if (t.interp > 1) {
      for (let k = 0; k < t.size; k++) val(t.inTan?.[i * t.size + k] ?? 0);
      for (let k = 0; k < t.size; k++) val(t.outTan?.[i * t.size + k] ?? 0);
    }
  }
}

const extent = (w: Writer, e: Model["extent"]) => { w.f32(e.radius); e.min.forEach((v) => w.f32(v)); e.max.forEach((v) => w.f32(v)); };

/** Node type flags (bone, light, event, attachment, emitters, …) are rewritten per chunk. */
const TYPE_FLAGS = 0xffff00;

/** Matrix groups for a geoset: Reforged skin weights (4 group indices + 4 weights per vertex)
 *  become one group per vertex of the bones with at least a quarter of its weight (else its
 *  strongest); Classic geosets keep theirs. */
function matrixGroups(g: Geoset): { groups: number[][]; vertexGroups: number[] } {
  const n = g.positions.length / 3;
  if (!g.skin) return { groups: g.groups, vertexGroups: Array.from(g.vertexGroups) };
  const groups: number[][] = [], index = new Map<string, number>(), vertexGroups: number[] = [];
  for (let v = 0; v < n; v++) {
    const pairs = [0, 1, 2, 3].map((k) => [g.skin![v * 8 + k], g.skin![v * 8 + 4 + k]] as const).filter(([, wt]) => wt > 0).sort((a, b) => b[1] - a[1]);
    const strong = pairs.filter(([, wt]) => wt >= 64);
    const bones = [...new Set((strong.length ? strong : pairs.slice(0, 1)).flatMap(([gi]) => g.groups[gi] ?? [gi]))].sort((a, b) => a - b);
    const key = bones.join(",");
    let i = index.get(key);
    if (i === undefined) { i = groups.length; groups.push(bones); index.set(key, i); }
    vertexGroups.push(i);
  }
  if (groups.length > 256) throw new Error(`a geoset needs ${groups.length} bone groups (Classic allows 256)`);
  return { groups, vertexGroups };
}

/** The model as Classic MDX 800. `texturePath(i)`: the new path of texture `i` (only colour
 *  textures are asked for; null drops it, and layers using it get the first kept one). */
export function toClassicMdx(m: Model, texturePath: (index: number) => string | null): Uint8Array {
  const w = new Writer();
  const geosets = m.geosets.map((g, i) => [g, i] as const).filter(([g]) => g.lod === 0);
  // Textures: the colour textures of the layers, renumbered; replaceable ones (team colour) kept as they are.
  const colour = [...new Set(m.materials.flatMap((mat) => mat.layers.map((l) => l.textureIds[0])))].filter((i) => m.textures[i]);
  const kept: { replaceableId: number; path: string; flags: number }[] = [];
  const remap = new Map<number, number>();
  for (const i of colour) {
    const t = m.textures[i];
    const path = t.replaceableId ? "" : texturePath(i);
    if (path === null) continue;
    remap.set(i, kept.length);
    kept.push({ replaceableId: t.replaceableId, path, flags: t.flags });
  }
  const tex = (i: number) => remap.get(i) ?? 0;
  const geosetIndex = new Map(geosets.map(([, old], i) => [old, i]));

  w.tag("MDLX");
  w.chunk("VERS", () => w.u32(800));
  w.chunk("MODL", () => { w.str(m.name, 80); w.str("", 260); extent(w, m.extent); w.u32(150); });
  if (m.sequences.length) w.chunk("SEQS", () => {
    for (const s of m.sequences) { w.str(s.name, 80); w.u32(s.start); w.u32(s.end); w.f32(s.moveSpeed); w.u32(s.flags); w.f32(s.rarity); w.u32(0); extent(w, s.extent); }
  });
  if (m.globalSequences.length) w.chunk("GLBS", () => m.globalSequences.forEach((d) => w.u32(d)));
  w.chunk("MTLS", () => {
    for (const mat of m.materials) {
      w.sized(() => {
        w.u32(mat.priorityPlane);
        w.u32(mat.flags);
        w.tag("LAYS");
        w.u32(mat.layers.length ? 1 : 0);
        const l = mat.layers[0];
        if (l) w.sized(() => {
          w.u32(l.filterMode); w.u32(l.shadingFlags); w.u32(tex(l.textureIds[0])); w.i32(l.textureAnimId); w.u32(l.coordId); w.f32(l.alpha);
          track(w, "KMTA", l.alphaTrack);
          track(w, "KMTF", l.textureTrack, tex);
        }, true);
      }, true);
    }
  });
  if (kept.length) w.chunk("TEXS", () => { for (const t of kept) { w.u32(t.replaceableId); w.str(t.path, 260); w.u32(t.flags); } });
  if (m.textureAnims.length) w.chunk("TXAN", () => {
    for (const a of m.textureAnims) w.sized(() => { track(w, "KTAT", a.translation); track(w, "KTAR", a.rotation); track(w, "KTAS", a.scaling); }, true);
  });
  w.chunk("GEOS", () => {
    for (const [g] of geosets) {
      const { groups, vertexGroups } = matrixGroups(g);
      w.sized(() => {
        const nv = g.positions.length / 3;
        w.tag("VRTX"); w.u32(nv); g.positions.forEach((v) => w.f32(v));
        w.tag("NRMS"); w.u32(nv); g.normals.forEach((v) => w.f32(v));
        w.tag("PTYP"); w.u32(1); w.u32(4);
        w.tag("PCNT"); w.u32(1); w.u32(g.faces.length);
        w.tag("PVTX"); w.u32(g.faces.length);
        const idx = new Uint8Array(g.faces.length * 2);
        new Uint16Array(idx.buffer).set(g.faces);
        w.bytes(idx);
        w.tag("GNDX"); w.u32(nv); vertexGroups.forEach((v) => w.u8(v));
        w.tag("MTGC"); w.u32(groups.length); groups.forEach((gr) => w.u32(gr.length));
        w.tag("MATS"); w.u32(groups.reduce((n, gr) => n + gr.length, 0)); groups.forEach((gr) => gr.forEach((b) => w.u32(b)));
        w.u32(g.materialId); w.u32(0); w.u32(0);
        extent(w, g.extent);
        w.u32(m.sequences.length); m.sequences.forEach(() => extent(w, g.extent));
        w.tag("UVAS"); w.u32(1);
        w.tag("UVBS"); w.u32(nv); g.uvs.forEach((v) => w.f32(v));
      }, true);
    }
  });
  const anims = m.geosetAnims.filter((a) => geosetIndex.has(a.geosetId));
  if (anims.length) w.chunk("GEOA", () => {
    for (const a of anims) w.sized(() => {
      // Flags: 2 = uses its colour.
      w.f32(a.alpha); w.u32(a.colorTrack || a.color.some((c) => c !== 1) ? 2 : 0); a.color.forEach((c) => w.f32(c)); w.u32(geosetIndex.get(a.geosetId)!);
      track(w, "KGAO", a.alphaTrack); track(w, "KGAC", a.colorTrack);
    }, true);
  });
  // Nodes by object id; ids, parents and pivots stay. Bones and attachments as such, the rest helpers.
  const nodes = m.nodes.filter(Boolean);
  const node = (n: (typeof nodes)[number], typeFlag: number) => w.sized(() => {
    w.str(n.name, 80); w.u32(n.objectId); w.i32(n.parentId); w.u32((n.flags & ~TYPE_FLAGS) | typeFlag);
    track(w, "KGTR", n.translation); track(w, "KGRT", n.rotation); track(w, "KGSC", n.scaling);
  }, true);
  const bones = nodes.filter((n) => n.kind === "bone"), atts = nodes.filter((n) => n.kind === "atch");
  const helpers = nodes.filter((n) => n.kind !== "bone" && n.kind !== "atch");
  if (bones.length) w.chunk("BONE", () => { for (const n of bones) { node(n, 0x100); w.i32(-1); w.i32(-1); } });
  if (helpers.length) w.chunk("HELP", () => { for (const n of helpers) node(n, 0); });
  if (atts.length) w.chunk("ATCH", () => {
    atts.forEach((n, i) => w.sized(() => { node(n, 0x800); w.str("", 260); w.u32(i); }, true));
  });
  const maxId = Math.max(-1, ...nodes.map((n) => n.objectId));
  w.chunk("PIVT", () => { for (let i = 0; i <= maxId; i++) for (let k = 0; k < 3; k++) w.f32(m.pivots[i * 3 + k] ?? 0); });
  return w.done();
}
