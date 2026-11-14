import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { writeLightMdl } from "./dnclight";
import { isMdlText, parseMdl, parseModel } from "./mdl";
import { parseMdx, type Model, type Node, type Track } from "./mdx";

// --- an MDX built here, and a writer of a parsed model as MDL text (both only for the tests) ------------------

class Bytes {
  parts: number[] = [];
  u32(v: number) { this.parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); return this; }
  f32(v: number) { this.parts.push(...new Uint8Array(new Float32Array([v]).buffer)); return this; }
  u16(v: number) { this.parts.push(v & 255, (v >> 8) & 255); return this; }
  tag(s: string) { this.parts.push(...[...s].map((c) => c.charCodeAt(0))); return this; }
  str(s: string, n: number) { const b = new Array(n).fill(0); [...s].forEach((c, i) => { b[i] = c.charCodeAt(0); }); this.parts.push(...b); return this; }
  /** Writes `body` after a size field; `inclusive`: the size counts the field itself (objects), else not (chunks). */
  sized(inclusive: boolean, body: () => void) {
    const at = this.parts.length;
    this.u32(0);
    body();
    const n = this.parts.length - at - (inclusive ? 0 : 4);
    this.parts.splice(at, 4, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
    return this;
  }
  chunk(tag: string, body: () => void) { this.tag(tag); return this.sized(false, body); }
  extent(r: number, min: number[], max: number[]) { this.f32(r); min.forEach((v) => this.f32(v)); max.forEach((v) => this.f32(v)); return this; }
  track(tag: string, interp: number, globalSeq: number, keys: [number, number[], number[]?, number[]?][]) {
    this.tag(tag).u32(keys.length).u32(interp).u32(globalSeq);
    for (const [t, v, i, o] of keys) { this.u32(t); v.forEach((x) => this.f32(x)); if (interp > 1) { i!.forEach((x) => this.f32(x)); o!.forEach((x) => this.f32(x)); } }
    return this;
  }
  done() { return new Uint8Array(this.parts); }
}

/** A version 800 model: two sequences, a global sequence, a texture, a material whose layer's alpha is animated,
 *  a geoset of two triangles on two bone groups, two bones (one with a Hermite translation on the global sequence,
 *  a linear rotation), a helper, pivots. */
function smallMdx(uvSets: number[][] = [[0, 0, 1, 0, 0, 1, 1, 1]]): Uint8Array {
  const b = new Bytes();
  b.tag("MDLX");
  b.chunk("VERS", () => b.u32(800));
  b.chunk("MODL", () => b.str("Small", 80).str("", 260).extent(5, [-1, -2, 0], [1, 2, 3]).u32(150));
  b.chunk("SEQS", () => {
    b.str("Stand", 80).u32(0).u32(1000).f32(0).u32(0).f32(0).u32(0).extent(4, [-1, -1, 0], [1, 1, 2]);
    b.str("Death", 80).u32(2000).u32(3333).f32(270).u32(1).f32(0.5).u32(0).extent(0, [0, 0, 0], [0, 0, 0]);
  });
  b.chunk("GLBS", () => b.u32(1633));
  b.chunk("TEXS", () => { b.u32(0).str("Textures\\Small.blp", 260).u32(3); b.u32(1).str("", 260).u32(0); });
  b.chunk("MTLS", () => b.sized(true, () => {
    b.u32(0).u32(0x20).tag("LAYS").u32(1);
    b.sized(true, () => { b.u32(2).u32(0x11).u32(0).u32(0xffffffff).u32(0).f32(1); b.track("KMTA", 1, 0xffffffff, [[0, [1]], [500, [0.25]]]); });
  }));
  b.chunk("GEOS", () => b.sized(true, () => {
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.5];
    b.tag("VRTX").u32(4); pos.forEach((v) => b.f32(v));
    b.tag("NRMS").u32(4); for (let i = 0; i < 4; i++) b.f32(0).f32(0).f32(1);
    b.tag("PTYP").u32(1).u32(4);
    b.tag("PCNT").u32(1).u32(6);
    b.tag("PVTX").u32(6); [0, 1, 2, 2, 1, 3].forEach((i) => b.u16(i));
    b.tag("GNDX").u32(4); b.parts.push(0, 0, 1, 1);
    b.tag("MTGC").u32(2).u32(1).u32(2);
    b.tag("MATS").u32(3).u32(0).u32(0).u32(1);
    b.u32(0).u32(0).u32(0).extent(1.5, [0, 0, 0], [1, 1, 0.5]).u32(1).extent(1, [0, 0, 0], [1, 1, 1]);
    b.tag("UVAS").u32(uvSets.length);
    for (const set of uvSets) { b.tag("UVBS").u32(4); set.forEach((v) => b.f32(v)); }
  }));
  b.chunk("BONE", () => {
    b.sized(true, () => {
      b.str("Root", 80).u32(0).u32(0xffffffff).u32(0x100);
      b.track("KGTR", 2, 0, [[0, [0, 0, 0], [0, 0, 1], [0, 0, -1]], [800, [0, 0, 10], [1, 2, 3], [4, 5, 6]]]);
      b.track("KGRT", 1, 0xffffffff, [[0, [0, 0, 0, 1]], [1000, [0, 0, 0.70710677, 0.70710677]]]);
    }).u32(0).u32(0xffffffff);
    b.sized(true, () => b.str("Arm", 80).u32(1).u32(0).u32(0x100 | 0x8)).u32(0).u32(0xffffffff);
  });
  b.chunk("HELP", () => b.sized(true, () => { b.str("Hold", 80).u32(2).u32(1).u32(0); b.track("KGSC", 0, 0xffffffff, [[0, [1, 1, 1]], [10, [2, 2, 2]]]); }));
  b.chunk("PIVT", () => [0, 0, 0, 0, 0, 50, 10, 0, 50].forEach((v) => b.f32(v)));
  return b.done();
}

const INTERP = ["DontInterp", "Linear", "Hermite", "Bezier"];
const FILTER = ["None", "Transparent", "Blend", "Additive", "AddAlpha", "Modulate", "Modulate2x"];
const num = (v: number) => (Number.isNaN(v) ? "-1.#IND" : v === Infinity ? "1.#INF" : v === -Infinity ? "-1.#INF" : Object.is(v, -0) ? "-0" : String(v));
const vec = (v: ArrayLike<number>) => `{ ${Array.from(v, num).join(", ")} }`;

/** A model as MDL text, in the style of the game's converter: what the reader under test should give back. */
function writeMdl(m: Model): string {
  const o: string[] = [];
  const flags = (bits: number, names: Record<string, number>) => Object.entries(names).filter(([, b]) => bits & b).map(([n]) => `\t\t${n},`);
  const track = (name: string, t: Track | undefined, ind: string, int = false) => {
    if (!t) return;
    const val = (a: Float32Array, i: number) => (t.size === 1 ? num(int ? Math.round(a[i]) : a[i]) : vec(a.subarray(i * t.size, (i + 1) * t.size)));
    o.push(`${ind}${name} ${t.times.length} {`, `${ind}\t${INTERP[t.interp]},`);
    if (t.globalSeq >= 0) o.push(`${ind}\tGlobalSeqId ${t.globalSeq},`);
    for (let i = 0; i < t.times.length; i++) {
      o.push(`${ind}\t${t.times[i]}: ${val(t.values, i)},`);
      if (t.interp > 1) o.push(`${ind}\t\tInTan ${val(t.inTan!, i)},`, `${ind}\t\tOutTan ${val(t.outTan!, i)},`);
    }
    o.push(`${ind}}`);
  };
  const extent = (e: Model["extent"], ind: string) => o.push(`${ind}MinimumExtent ${vec(e.min)},`, `${ind}MaximumExtent ${vec(e.max)},`, `${ind}BoundsRadius ${num(e.radius)},`);
  const node = (block: string, n: Node, own: () => void = () => {}) => {
    o.push(`${block} "${n.name}" {`, `\tObjectId ${n.objectId},`);
    if (n.parentId >= 0) o.push(`\tParent ${n.parentId},`);
    o.push(...flags(n.flags, { Billboarded: 0x8, BillboardedLockX: 0x10, BillboardedLockY: 0x20, BillboardedLockZ: 0x40, CameraAnchored: 0x80 }).map((l) => l.slice(1)));
    const inherit = Object.entries({ Translation: 1, Rotation: 2, Scaling: 4 }).filter(([, b]) => n.flags & b).map(([k]) => k);
    if (inherit.length) o.push(`\tDontInherit { ${inherit.join(", ")} },`);
    own();
    track("Translation", n.translation, "\t");
    track("Rotation", n.rotation, "\t");
    track("Scaling", n.scaling, "\t");
    o.push("}");
  };
  const prop = (name: string, value: number | ArrayLike<number>, t: Track | undefined, ind: string, int = false) => {
    if (t) track(name, t, ind, int);
    else o.push(`${ind}static ${name} ${typeof value === "number" ? num(value) : vec(value)},`);
  };
  o.push("// written by mdl.test.ts", `Version {`, `\tFormatVersion ${m.version},`, `}`, `Model "${m.name}" {`, `\tNumGeosets ${m.geosets.length},`, `\tBlendTime 150,`);
  extent(m.extent, "\t");
  o.push("}");
  if (m.sequences.length) {
    o.push(`Sequences ${m.sequences.length} {`);
    for (const s of m.sequences) {
      o.push(`\tAnim "${s.name}" {`, `\t\tInterval { ${s.start}, ${s.end} },`);
      if (s.flags & 1) o.push("\t\tNonLooping,");
      if (s.moveSpeed) o.push(`\t\tMoveSpeed ${num(s.moveSpeed)},`);
      if (s.rarity) o.push(`\t\tRarity ${num(s.rarity)},`);
      extent(s.extent, "\t\t");
      o.push("\t}");
    }
    o.push("}");
  }
  if (m.globalSequences.length) o.push(`GlobalSequences ${m.globalSequences.length} {`, ...m.globalSequences.map((d) => `\tDuration ${d},`), "}");
  if (m.textures.length) {
    o.push(`Textures ${m.textures.length} {`);
    for (const t of m.textures) {
      o.push("\tBitmap {", `\t\tImage "${t.path}",`);
      if (t.replaceableId) o.push(`\t\tReplaceableId ${t.replaceableId},`);
      o.push(...flags(t.flags, { WrapWidth: 1, WrapHeight: 2 }), "\t}");
    }
    o.push("}");
  }
  if (m.materials.length) {
    o.push(`Materials ${m.materials.length} {`);
    for (const mat of m.materials) {
      o.push("\tMaterial {", ...flags(mat.flags, { ConstantColor: 1, SortPrimsNearZ: 8, SortPrimsFarZ: 0x10, FullResolution: 0x20 }));
      if (mat.priorityPlane) o.push(`\t\tPriorityPlane ${mat.priorityPlane},`);
      for (const l of mat.layers) {
        o.push("\t\tLayer {", `\t\t\tFilterMode ${FILTER[l.filterMode]},`);
        o.push(...flags(l.shadingFlags, { Unshaded: 1, SphereEnvMap: 2, TwoSided: 0x10, Unfogged: 0x20, NoDepthTest: 0x40, NoDepthSet: 0x80 }).map((s) => `\t${s}`));
        // A Reforged layer names one TextureID per slot; the first slot's track is the layer's texture track.
        l.textureIds.forEach((id, slot) => prop("TextureID", id, slot === 0 ? l.textureTrack : l.slotTracks?.[slot], "\t\t\t", true));
        prop("Alpha", l.alpha, l.alphaTrack, "\t\t\t");
        if (l.textureAnimId >= 0) o.push(`\t\t\tTVertexAnimId ${l.textureAnimId},`);
        if (l.coordId) o.push(`\t\t\tCoordId ${l.coordId},`);
        o.push("\t\t}");
      }
      o.push("\t}");
    }
    o.push("}");
  }
  if (m.textureAnims.length) {
    o.push(`TextureAnims ${m.textureAnims.length} {`);
    for (const a of m.textureAnims) {
      o.push("\tTVertexAnim {");
      track("Translation", a.translation, "\t\t");
      track("Rotation", a.rotation, "\t\t");
      track("Scaling", a.scaling, "\t\t");
      o.push("\t}");
    }
    o.push("}");
  }
  for (const g of m.geosets) {
    const n = g.positions.length / 3;
    const rows = (a: ArrayLike<number>, size: number) => Array.from({ length: a.length / size }, (_, i) => `\t\t${vec(Array.from(a).slice(i * size, (i + 1) * size))},`);
    o.push("Geoset {", `\tVertices ${n} {`, ...rows(g.positions, 3), "\t}", `\tNormals ${n} {`, ...rows(g.normals, 3), "\t}");
    o.push(`\tTVertices ${g.uvs.length / 2} {`, ...rows(g.uvs, 2), "\t}");
    if (g.uvs2) o.push(`\tTVertices ${g.uvs2.length / 2} {`, ...rows(g.uvs2, 2), "\t}");
    o.push("\tVertexGroup {", ...Array.from(g.vertexGroups, (v) => `\t\t${v},`), "\t}");
    if (g.skin) o.push(`\tSkinWeights ${n} {`, ...rows(g.skin, 8), "\t}");
    o.push(`\tFaces 1 ${g.faces.length} {`, "\t\tTriangles {", `\t\t\t${vec(g.faces)},`, "\t\t}", "\t}");
    o.push(`\tGroups ${g.groups.length} ${g.groups.reduce((a, x) => a + x.length, 0)} {`, ...g.groups.map((x) => `\t\tMatrices ${vec(x)},`), "\t}");
    extent(g.extent, "\t");
    o.push(`\tMaterialID ${g.materialId},`, "\tSelectionGroup 0,");
    if (m.version > 800) o.push(`\tLevelOfDetail ${g.lod},`, `\tName "${g.lodName}",`);
    o.push("}");
  }
  for (const a of m.geosetAnims) {
    o.push("GeosetAnim {");
    prop("Alpha", a.alpha, a.alphaTrack, "\t");
    prop("Color", a.color, a.colorTrack, "\t");
    o.push(`\tGeosetId ${a.geosetId},`, "}");
  }
  const lights = new Map((m.lights ?? []).map((l) => [l.node, l]));
  const pre2 = new Map(m.particleEmitters2.map((e) => [e.node, e]));
  const ribbons = new Map(m.ribbons.map((e) => [e.node, e]));
  for (const n of m.nodes) {
    if (!n) continue;
    const e = pre2.get(n), r = ribbons.get(n), l = lights.get(n);
    if (n.kind === "bone") node("Bone", n, () => o.push("\tGeosetId Multiple,", "\tGeosetAnimId None,"));
    else if (n.kind === "helper") node("Helper", n);
    else if (n.kind === "atch") node("Attachment", n, () => o.push("\tAttachmentID 0,"));
    else if (n.kind === "event") node("EventObject", n, () => o.push("\tEventTrack 1 {", "\t\t10,", "\t}"));
    else if (n.kind === "prem") node("ParticleEmitter", n);
    else if (n.kind === "corn") node("ParticleEmitterPopcorn", n);
    else if (n.kind === "lite") node("Light", n, () => {
      if (!l) return;
      o.push(`\t${["Omnidirectional", "Directional", "Ambient"][l.type]},`, `\tstatic AttenuationStart ${num(l.attenuationStart)},`, `\tstatic AttenuationEnd ${num(l.attenuationEnd)},`);
      prop("Color", l.color, l.colorTrack, "\t");
      prop("Intensity", l.intensity, l.intensityTrack, "\t");
    });
    else if (e) node("ParticleEmitter2", n, () => {
      o.push(...flags(n.flags, { Unshaded: 0x8000, SortPrimsFarZ: 0x10000, LineEmitter: 0x20000, Unfogged: 0x40000, ModelSpace: 0x80000, XYQuad: 0x100000 }).map((s) => s.slice(1)));
      prop("Speed", e.speed, e.speedTrack, "\t"); prop("Variation", e.variation, e.variationTrack, "\t");
      prop("Latitude", e.latitude, e.latitudeTrack, "\t"); prop("Gravity", e.gravity, e.gravityTrack, "\t");
      track("Visibility", e.visibilityTrack, "\t");
      prop("EmissionRate", e.emissionRate, e.emissionRateTrack, "\t"); prop("Width", e.width, e.widthTrack, "\t"); prop("Length", e.length, e.lengthTrack, "\t");
      o.push(`\t${["Blend", "Additive", "Modulate", "Modulate2x", "AlphaKey"][e.filterMode]},`, `\tRows ${e.rows},`, `\tColumns ${e.columns},`, `\t${["Head", "Tail", "Both"][e.headOrTail]},`);
      o.push(`\tTailLength ${num(e.tailLength)},`, `\tTime ${num(e.time)},`, "\tSegmentColor {", ...e.segmentColor.map((c) => `\t\tColor ${vec(c)},`), "\t},");
      o.push(`\tAlpha ${vec(e.segmentAlpha)},`, `\tParticleScaling ${vec(e.segmentScaling)},`, `\tLifeSpanUVAnim ${vec(e.headIntervals)},`, `\tDecayUVAnim ${vec(e.headDecayIntervals)},`);
      o.push(`\tTailUVAnim ${vec(e.tailIntervals)},`, `\tTailDecayUVAnim ${vec(e.tailDecayIntervals)},`, `\tTextureID ${e.textureId},`, `\tLifeSpan ${num(e.lifespan)},`);
      if (e.squirt) o.push("\tSquirt,");
      o.push(`\tPriorityPlane ${e.priorityPlane},`, `\tReplaceableId ${e.replaceableId},`);
    });
    else if (r) node("RibbonEmitter", n, () => {
      prop("HeightAbove", r.heightAbove, r.heightAboveTrack, "\t"); prop("HeightBelow", r.heightBelow, r.heightBelowTrack, "\t");
      prop("Alpha", r.alpha, r.alphaTrack, "\t"); prop("Color", r.color, r.colorTrack, "\t");
      prop("TextureSlot", r.textureSlot, r.textureSlotTrack, "\t", true); track("Visibility", r.visibilityTrack, "\t");
      o.push(`\tEmissionRate ${r.emissionRate},`, `\tLifeSpan ${num(r.lifespan)},`, `\tGravity ${num(r.gravity)},`, `\tRows ${r.rows},`, `\tColumns ${r.columns},`, `\tMaterialID ${r.materialId},`);
    });
  }
  o.push(`PivotPoints ${m.pivots.length / 3} {`, ...Array.from({ length: m.pivots.length / 3 }, (_, i) => `\t${vec(m.pivots.subarray(i * 3, i * 3 + 3))},`), "}");
  for (const tag of m.skipped) if (tag === "CAMS") o.push('Camera "Cam" {', "\tFieldOfView 0.7,", "\tTarget {", "\t\tPosition { 1, 2, 3 },", "\t}", "}");
  return o.join("\n") + "\n";
}

/** What both readers should agree on, with typed arrays as plain ones (for deepEqual and readable diffs). */
function comparable(m: Model) {
  const plain = (v: unknown): unknown => {
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, plain(x)]));
    return v;
  };
  // All of a Reforged layer's texture slots are compared; the per-slot tracks are kept apart only by mdx.ts's layout.
  const materials = m.materials.map((mat) => ({ ...mat, layers: mat.layers.map(({ slotTracks: _s, ...l }) => l) }));
  return plain({
    version: m.version, name: m.name, extent: m.extent, sequences: m.sequences, globalSequences: m.globalSequences, textures: m.textures, materials,
    geosets: m.geosets.map((g) => ({ ...g, vertexGroups: Array.from(g.vertexGroups) })), geosetAnims: m.geosetAnims, nodes: m.nodes, pivots: m.pivots,
    particleEmitters2: m.particleEmitters2, ribbons: m.ribbons, textureAnims: m.textureAnims, lights: m.lights,
  });
}

// --- tests ------------------------------------------------------------------------------------------------------

test("a geoset's second texture coordinate set is kept for layers with CoordId 1 (the classic cliff doodads' overlay); a third isn't", () => {
  const second = [0.5, 0.5, 0.25, 0.5, 0.5, 0.25, 0.75, 0.75];
  const g = parseMdx(smallMdx([[0, 0, 1, 0, 0, 1, 1, 1], second, [9, 9, 9, 9, 9, 9, 9, 9]])).geosets[0];
  assert.deepEqual([...g.uvs], [0, 0, 1, 0, 0, 1, 1, 1]);
  assert.deepEqual([...(g.uvs2 ?? [])], second);
  // One set: none.
  assert.equal(parseMdx(smallMdx()).geosets[0].uvs2, undefined);
});

test("a model written as MDL text reads back as the MDX reader read it", () => {
  const fromMdx = parseMdx(smallMdx());
  const text = writeMdl(fromMdx);
  const fromMdl = parseMdl(text);
  assert.deepEqual(fromMdl.warnings, []);
  assert.equal(fromMdl.geosets[0].positions.length / 3, 4, "vertices");
  assert.equal(fromMdl.geosets[0].faces.length / 3, 2, "triangles");
  assert.equal(fromMdl.nodes.filter((n) => n.kind === "bone").length, 2, "bones");
  assert.deepEqual(fromMdl.sequences.map((s) => s.name), ["Stand", "Death"]);
  const t = fromMdl.nodes[0].translation!;
  assert.equal(t.interp, 2);
  assert.equal(t.globalSeq, 0);
  assert.deepEqual([...t.times], [0, 800]);
  assert.deepEqual([...t.values], [0, 0, 0, 0, 0, 10]);
  assert.deepEqual([...t.inTan!], [0, 0, 1, 1, 2, 3]);
  assert.deepEqual([...t.outTan!], [0, 0, -1, 4, 5, 6]);
  assert.deepEqual(comparable(fromMdl), comparable(fromMdx));
  // Control: a changed key shows (the comparison can fail).
  const changed = parseMdl(text.replace("800: { 0, 0, 10 }", "800: { 0, 0, 11 }"));
  assert.notDeepEqual(comparable(changed), comparable(fromMdx));
});

test("a Reforged MDL layer reads every TextureID slot, as the MDX reader does", () => {
  const text = (layer: string) => `Version {
	FormatVersion 1000,
}
Model "HD" {
	NumGeosets 0,
}
Textures 4 {
	Bitmap { Image "u_Diffuse.dds", }
	Bitmap { Image "u_Normal.dds", }
	Bitmap { Image "u_ORM.dds", }
	Bitmap { Image "u_Emissive.dds", }
}
Materials 1 {
	Material {
		Shader "Shader_HD_DefaultUnit",
		Layer {
			FilterMode None,
${layer}
		}
	}
}
`;
  const m = parseMdl(text(`			static TextureID 0,
			static TextureID 1,
			TextureID 2 { DontInterp, 0: 2, 500: 3, }
			static TextureID 3,
			static EmissiveGain 1,`));
  assert.deepEqual(m.warnings, []);
  const l = m.materials[0].layers[0];
  assert.deepEqual(l.textureIds, [0, 1, 2, 3]);
  assert.equal(l.textureTrack, undefined, "the diffuse slot has no flipbook");
  assert.deepEqual([...l.slotTracks![2]!.values], [2, 3], "the ORM slot keeps its track");
  // A classic layer: one slot, its track is the layer's texture track, no slot tracks.
  const classic = parseMdl(text("\t\t\tTextureID 1 { DontInterp, 0: 1, 500: 0, }")).materials[0].layers[0];
  assert.deepEqual(classic.textureIds, [1]);
  assert.deepEqual([...classic.textureTrack!.values], [1, 0]);
  assert.equal(classic.slotTracks, undefined);
});

test("MDL text written by hand: comments, static values, tracks, flags, the node kinds", () => {
  const m = parseMdl(`// a comment line
Version {
	FormatVersion 800,
}
Model "Hand" {
	NumGeosets 1,
	BlendTime 150,
	MinimumExtent { -10, -10.5, 0 },
	MaximumExtent { 10, 10.5, 1e2 },
	BoundsRadius 15,
}
Sequences 1 {
	Anim "Walk" { Interval { 100, 900 }, MoveSpeed 270, Rarity 2, NonLooping, }
}
Textures 1 {
	Bitmap { Image "Units\\Hand\\Hand.blp", WrapWidth, }
}
Materials 1 {
	Material {
		ConstantColor,
		Layer {
			FilterMode Additive,
			Unshaded,
			TwoSided,
			TextureID 2 { DontInterp, 0: 0, 500: 1, }
			static Alpha 0.5,
			TVertexAnimId 0,
		}
	}
}
TextureAnims 1 { TVertexAnim { Translation 1 { Bezier, 0: { 1, 2, 3 }, InTan { 4, 5, 6 }, OutTan { 7, 8, 9 }, } } }
Geoset {
	Vertices 3 { { 0, 0, 0 }, { 1, 0, 0 }, { 0, 1, 0 }, }
	Normals 3 { { 0, 0, 1 }, { 0, 0, 1 }, { 0, 0, 1 }, }
	TVertices 3 { { 0, 0 }, { 1, 0 }, { 0, 1 }, }
	VertexGroup { 0, 0, 0, }
	Faces 1 3 { Triangles { { 0, 1, 2 }, }, }
	Groups 1 1 { Matrices { 0 }, }
	MaterialID 0,
	Unselectable,
}
GeosetAnim {
	Alpha 1 { Linear, GlobalSeqId 0, 0: 0.5, }
	static Color { 0.1, 0.2, 0.3 },
	GeosetId 0,
}
Bone "B" { ObjectId 0, GeosetId 0, GeosetAnimId None, Billboarded, DontInherit { Rotation }, }
Attachment "Origin Ref" { ObjectId 1, Parent 0, AttachmentID 0, Visibility 1 { DontInterp, 0: 1, } }
EventObject "SNDxABCD" { ObjectId 2, EventTrack 1 { 5, } }
ParticleEmitter2 "Fx" {
	ObjectId 3,
	Unshaded, ModelSpace,
	static Speed 100,
	EmissionRate 2 { Linear, 0: 0, 100: 20, }
	Additive, Tail, Squirt,
	SegmentColor { Color { 1, 0, 0 }, Color { 0, 1, 0 }, Color { 0, 0, 1 }, },
	Alpha { 255, 128, 0 },
	LifeSpanUVAnim { 0, 3, 1 },
	Rows 2, Columns 2, TextureID 0, Time 0.25, LifeSpan 1.5,
}
RibbonEmitter "Rb" { ObjectId 4, static HeightAbove 10, static Color { 1, 0.5, 0 }, EmissionRate 30, MaterialID 0, Rows 1, Columns 1, }
Light "L" { ObjectId 5, Directional, static AttenuationStart 80, static AttenuationEnd 200, }
ParticleEmitterPopcorn "P" { ObjectId 6, Path "x.pkfx", }
CollisionShape "C" { ObjectId 7, Box, Vertices 2 { { 0, 0, 0 }, { 1, 1, 1 }, } }
PivotPoints 8 { { 0, 0, 0 }, { 1, 2, 3 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 }, }
`);
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.extent, { radius: 15, min: [-10, -10.5, 0], max: [10, 10.5, 100] });
  assert.deepEqual(m.sequences[0], { name: "Walk", start: 100, end: 900, moveSpeed: 270, flags: 1, rarity: 2, extent: { radius: 0, min: [0, 0, 0], max: [0, 0, 0] } });
  assert.deepEqual(m.textures, [{ replaceableId: 0, path: "Units\\Hand\\Hand.blp", flags: 1 }], "the path keeps its backslashes");
  const l = m.materials[0].layers[0];
  assert.equal(m.materials[0].flags, 1);
  assert.deepEqual([l.filterMode, l.shadingFlags, l.alpha, l.textureAnimId], [3, 0x11, 0.5, 0]);
  assert.deepEqual([...l.textureTrack!.values], [0, 1]);
  assert.equal(l.textureTrack!.interp, 0);
  const ta = m.textureAnims[0].translation!;
  assert.deepEqual([ta.interp, [...ta.values], [...ta.inTan!], [...ta.outTan!]], [3, [1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.deepEqual([...m.geosets[0].faces], [0, 1, 2]);
  assert.deepEqual(m.geosets[0].groups, [[0]]);
  const ga = m.geosetAnims[0];
  assert.deepEqual([ga.alpha, [...ga.alphaTrack!.values], ga.alphaTrack!.globalSeq, ga.color], [1, [0.5], 0, [Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]],
    "an animated alpha keeps the default beside its track (the text has no fixed value for it)");
  assert.deepEqual(m.nodes.map((n) => n && [n.kind, n.objectId, n.parentId, n.flags]), [
    ["bone", 0, -1, 0x100 | 0x8 | 0x2], ["atch", 1, 0, 0x800], ["event", 2, -1, 0x400], ["pre2", 3, -1, 0x1000 | 0x8000 | 0x80000],
    ["ribb", 4, -1, 0x4000], ["lite", 5, -1, 0x200], ["corn", 6, -1, 0],
  ], "the collision shape is skipped, as the MDX reader skips CLID");
  const e = m.particleEmitters2[0];
  assert.deepEqual([e.speed, e.filterMode, e.headOrTail, e.squirt, e.rows, e.time, e.lifespan], [100, 1, 1, true, 2, 0.25, 1.5]);
  assert.deepEqual([...e.emissionRateTrack!.values], [0, 20]);
  assert.deepEqual([e.segmentColor, e.segmentAlpha, e.headIntervals], [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [255, 128, 0], [0, 3, 1]]);
  assert.deepEqual([m.ribbons[0].heightAbove, m.ribbons[0].color, m.ribbons[0].emissionRate], [10, [1, 0.5, 0], 30]);
  assert.deepEqual(m.lights?.map((x) => [x.type, x.attenuationStart, x.attenuationEnd]), [[1, 80, 200]]);
  assert.deepEqual(m.skipped, ["LITE", "CORN", "CLID"]);
  assert.deepEqual([...m.pivots.subarray(3, 6)], [1, 2, 3]);
});

test("unknown blocks and entries are skipped with a warning; Reforged geoset entries are read", () => {
  const m = parseMdl(`Version { FormatVersion 1000, }
FaceFX "f" { Path "x" }
Wobble 3 { { 1, 2 }, Nested { a { b } }, }
Geoset {
	Vertices 1 { { 1, 2, 3 }, }
	Normals 1 { { 0, 0, 1 }, }
	TVertices 1 { { 0.5, 0.5 }, }
	TVertices 1 { { 9, 9 }, }
	Tangents 1 { { 1, 0, 0, 1 }, }
	SkinWeights 1 { 0, 1, 0, 0, 200, 55, 0, 0, }
	VertexGroup { 0, }
	Faces 1 3 { Triangles { { 0, 0, 0 }, }, }
	Groups 2 2 { Matrices { 0 }, Matrices { 1 }, }
	Sparkle 7,
	LevelOfDetail 1,
	Name "Body",
}
`);
  assert.equal(m.version, 1000);
  assert.deepEqual(m.skipped, ["FAFX", "Wobble"]);
  assert.deepEqual(m.warnings, ["Wobble: block not read", "Geoset: Sparkle not read"]);
  const g = m.geosets[0];
  assert.deepEqual([...g.uvs], [0.5, 0.5], "the first coordinate set");
  assert.deepEqual([...(g.uvs2 ?? [])], [9, 9], "the second, for layers with CoordId 1");
  assert.deepEqual([...g.skin!], [0, 1, 0, 0, 200, 55, 0, 0]);
  assert.deepEqual([g.lod, g.lodName], [1, "Body"]);
});

test("a lighting model as the World Editor writes it (dnclight's writer) reads as a model with a light", () => {
  const key = (time: number, value: number[]) => ({ time, value });
  const text = writeLightMdl({
    version: 800, name: "DNCTest", blendTime: 150, globalSequences: [],
    sequences: [{ name: "Stand", start: 0, end: 60000, moveSpeed: 0, nonLooping: false, rarity: 0 }],
    lights: [{
      name: "Sun", objectId: 0, parentId: -1, flags: 0x200, type: 1, unknown: 0,
      attenuationStart: { value: [80] }, attenuationEnd: { value: [200] }, intensity: { value: [1.95] },
      color: { track: { interp: 1, globalSeq: -1, keys: [key(0, [0.5, 0.25, 0.125]), key(60000, [1, 1, 1])] } },
      ambIntensity: { value: [0.00001] }, ambColor: { value: [1, 1, 1] },
      shadowIntensity: 0.4, shadowCastingStart: 0, shadowCastingEnd: 0, quadraticFalloff: 0, linearFalloff: 0, damping: 0,
      rotation: { interp: 1, globalSeq: -1, keys: [key(0, [0, 0, 0, 1]), key(60000, [0, 0, 1, 0])] },
    }],
    pivots: [[1, 2, 3]],
  });
  const m = parseMdl(text);
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.sequences.map((s) => [s.name, s.end]), [["Stand", 60000]]);
  assert.deepEqual(m.lights?.map((l) => [l.node.name, l.type, l.attenuationStart, l.attenuationEnd]), [["Sun", 1, 80, 200]]);
  assert.deepEqual([...m.nodes[0].rotation!.values], [0, 0, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual([...m.pivots], [1, 2, 3]);
});

test("parseModel tells MDX from MDL by content", () => {
  const mdx = smallMdx();
  assert.equal(isMdlText(mdx), false);
  assert.equal(parseModel(mdx).geosets.length, 1);
  const text = new TextEncoder().encode(writeMdl(parseMdx(mdx)));
  assert.equal(isMdlText(text), true);
  assert.equal(parseModel(text).geosets.length, 1);
  const bom = parseModel(new Uint8Array([0xef, 0xbb, 0xbf, ...text]));
  assert.deepEqual([bom.version, bom.geosets.length, bom.warnings], [800, 1, []], "a UTF-8 byte order mark before the first comment");
  assert.throws(() => parseModel(new Uint8Array([1, 0, 2, 3])), /MDLX/, "binary that isn't MDX is still refused by the MDX reader");
  assert.throws(() => parseModel(new TextEncoder().encode("just a readme\n")), /not an MDL model/);
  assert.throws(() => parseModel(new Uint8Array(0)), /not an MDL model/);
});

test("damaged MDL text is refused or read in part, never thrown as anything but an Error", () => {
  const good = writeMdl(parseMdx(smallMdx()));
  const refused = (text: string, why: RegExp, what: string) => assert.throws(() => parseMdl(text), why, what);
  refused(good.slice(0, good.indexOf("Faces")), /Geoset: line \d+: .* expected, found the end/, "cut off inside a geoset");
  refused(good.replace("\t\t{ 0, 0, 0 },", "\t\t{ 0, zero, 0 },"), /Geoset: line \d+: number expected, found "zero"/, "a word where a number goes");
  refused(good.replace("ObjectId 1,", "ObjectId 99999999,"), /Bone: node id 99999999/, "a node id far past the file");
  refused(good.replace("Triangles", "Lines"), /unsupported primitive type Lines/, "primitives the renderer doesn't draw");
  refused(good.replace("SelectionGroup 0,", "SkinWeights 1 { 1, 2 },"), /SkinWeights of 2 numbers for 4 vertices/, "skin weights that don't fit the vertices");

  // Counts are not trusted: what is in the braces counts.
  const counts = parseMdl(good.replace("Vertices 4 {", "Vertices -5 {").replace(/Sequences 2 \{/, "Sequences 4294967295 {"));
  assert.equal(counts.geosets[0].positions.length, 12);
  assert.equal(counts.sequences.length, 2);

  // Stray and unclosed braces outside the needed blocks: warnings, the rest read.
  const stray = parseMdl(`Version { FormatVersion 800, }\n}}}\nCamera "c" { { { {\n`);
  assert.equal(stray.version, 800);
  assert.ok(stray.warnings.some((w) => /stray/.test(w)));
  const unclosed = parseMdl(`Version { FormatVersion 800, }\nTextureAnims 1 { TVertexAnim { Translation 1 { Linear, 0: { 1, 2`);
  assert.ok(unclosed.warnings.some((w) => /^TextureAnims: line \d+:/.test(w)), unclosed.warnings.join("; "));

  // Deep nesting and a long file of repeats: no recursion to overflow, no slow path.
  const deep = `Version { FormatVersion 800, }\nWobble ${"{".repeat(200000)}`;
  assert.equal(parseMdl(deep).version, 800);
  const many = `Version { FormatVersion 800, }\n${'Helper "h" { ObjectId 0, }\n'.repeat(20000)}`;
  const t0 = performance.now();
  assert.equal(parseMdl(many).nodes.length, 1);
  assert.ok(performance.now() - t0 < 4000);

  // Odd numbers some converters print.
  const odd = parseMdl(good.replace("BoundsRadius 5,", "BoundsRadius -1.#IND,").replace("{ -1, -2, 0 }", "{ 1.#INF, -2, 0 }"));
  assert.ok(Number.isNaN(odd.extent.radius));
  assert.equal(odd.extent.min[0], Infinity);
  // An unterminated string ends at its line.
  assert.equal(parseMdl(good.replace('Image "Textures\\Small.blp",', 'Image "Textures\\Small.blp\n,')).textures[0].path, "Textures\\Small.blp");
});

// --- the game's own models, when the game and the release CLI are here ----------------------------------------

function gameModels(names: string[]): { name: string; bytes: Uint8Array }[] {
  const git = (arg: string) => { const r = spawnSync("git", ["rev-parse", arg], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const repo = git("--show-toplevel"), common = git("--git-common-dir");
  if (!repo) return [];
  const main = common ? dirname(resolve(common)) : repo;
  const exe = `w3proj${process.platform === "win32" ? ".exe" : ""}`;
  const bin = [process.env.W3PROJ_BIN, join(repo, "target", "release", exe), join(main, "target", "release", exe)].find((p) => p && existsSync(p));
  const gameFile = join(main, ".game-path");
  // One folder per line; the first that exists wins (a checkout shared by a Windows and a Linux machine), as in tests/gamepath.mjs.
  const listed = existsSync(gameFile) ? readFileSync(gameFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  const game = process.env.W3PROJ_GAME ?? listed.find((p) => existsSync(p)) ?? listed[0];
  if (!bin) return [];
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const name of names) {
    const r = spawnSync(bin, ["game", "cat", name, ...(game ? ["--install", game] : [])], { maxBuffer: 1 << 28 });
    if (r.status === 0 && r.stdout.length) out.push({ name, bytes: new Uint8Array(r.stdout) });
  }
  return out;
}

test("the game's models written as MDL text read back as the MDX reader read them", (ctx) => {
  const models = gameModels([
    "War3.w3mod:Units/Human/Footman/Footman.mdx",
    "War3.w3mod:_HD.w3mod:Units/Human/Footman/Footman.mdx",
    "War3.w3mod:Doodads/Terrain/LordaeronTree/LordaeronTree0.mdx",
    "War3.w3mod:Abilities/Spells/Human/Blizzard/BlizzardTarget.mdx",
    "War3.w3mod:Abilities/Spells/NightElf/Starfall/StarfallTarget.mdx",
    "War3.w3mod:Abilities/Weapons/FarseerMissile/FarseerMissile.mdx",
  ]);
  if (!models.length) return ctx.skip("no game or release CLI (.game-path, target/release/w3proj)");
  for (const { name, bytes } of models) {
    const fromMdx = parseMdx(bytes);
    const fromMdl = parseModel(new TextEncoder().encode(writeMdl(fromMdx)));
    assert.deepEqual(fromMdl.warnings, [], name);
    // The first difference, not the whole model: these are tens of thousands of numbers.
    assert.equal(firstDiff(comparable(fromMdl), comparable(fromMdx)), null, name);
  }
});

function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (Object.is(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} (MDL) vs ${JSON.stringify(b)} (MDX)`;
}
