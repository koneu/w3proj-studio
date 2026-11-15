// What a model needs for Classic graphics to draw it, checked on its bytes. The Convert to Classic fix (classic.ts)
// writes MDX 800 and nothing in Studio can show whether the game's Classic loader takes such a file, so this walks
// the file on its own (not with the parser the converter is tested with) and reports:
// - errors: what makes the file unreadable: a chunk, object, track or geoset block whose size doesn't add up, a
//   geoset whose faces point past its vertices, a material or layer that isn't laid out as in version 800. The
//   Classic models in real maps (2,300 MDX 800 files of smoketest_maps, all drawn by the game) have none of these:
//   classiccheck.test.ts holds that as the control.
// - warnings: what a model the game reads may still lack to be seen: no geoset, material or sequence, a layer or
//   geoset naming a texture, material or matrix group that isn't there, a texture that isn't a BLP or isn't in the
//   map, node ids that aren't 0…n-1 in the order of the node chunks, pivots short of the nodes, chunks of later
//   versions. Real maps carry such models too (effects without geosets, a .dds texture), so these only say "not
//   the shape the game's Classic models have"; a converted model must have none (convertToClassic refuses one).

const LATIN1 = new TextDecoder("latin1");

/** Node chunks in the order Classic models list them. */
const NODE_ORDER = ["BONE", "LITE", "HELP", "ATCH", "PREM", "PRE2", "CORN", "RIBB", "EVTS", "CLID"];
/** Chunks of version 800. */
const CLASSIC_CHUNKS = new Set(["VERS", "MODL", "SEQS", "GLBS", "MTLS", "TEXS", "TXAN", "GEOS", "GEOA", "PIVT", "CAMS", ...NODE_ORDER.filter((t) => t !== "CORN")]);

/** Track value sizes in bytes; a track not listed can't be stepped over. */
const TRACK_VALUE: Record<string, number> = {
  KGTR: 12, KGRT: 16, KGSC: 12, KGAO: 4, KGAC: 12, KMTF: 4, KMTA: 4, KMTE: 4, KFC3: 12, KFCA: 4, KFTC: 4, KATV: 4, KTAT: 12,
  KTAR: 16, KTAS: 12, KP2V: 4, KP2S: 4, KP2L: 4, KP2G: 4, KP2E: 4, KP2N: 4, KP2W: 4, KP2R: 4, KRVS: 4, KRHA: 4, KRHB: 4,
  KRAL: 4, KRCO: 12, KRTX: 4, KLAS: 4, KLAE: 4, KLAC: 12, KLIC: 12, KLAI: 4, KLBI: 4, KLBC: 12, KLAV: 4, KCTR: 12, KTTR: 12,
  KCRL: 4, KPPV: 4, KPPA: 4, KPPE: 4, KPPC: 12, KPPL: 4, KPPR: 4, KPPS: 4, KPEV: 4, KPLN: 4, KPLT: 4, KPEL: 4, KPES: 4,
};

export interface ClassicCheckOptions {
  /** Whether the map has a texture, by archive path (backslashes; compare without case). Not given: not checked. */
  hasTexture?: (path: string) => boolean;
}

export interface ClassicCheck {
  /** The file can't be read as MDX 800. */
  errors: string[];
  /** It can, but lacks something the game's Classic models have. */
  warnings: string[];
}

class Bytes {
  readonly dv: DataView;
  constructor(readonly u8: Uint8Array) { this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
  has(o: number, n: number) { return o >= 0 && n >= 0 && o + n <= this.u8.length; }
  u32(o: number) { return this.dv.getUint32(o, true); }
  i32(o: number) { return this.dv.getInt32(o, true); }
  u16(o: number) { return this.dv.getUint16(o, true); }
  tag(o: number) { return String.fromCharCode(this.u8[o], this.u8[o + 1], this.u8[o + 2], this.u8[o + 3]); }
  str(o: number, n: number) { const b = this.u8.subarray(o, o + n); const z = b.indexOf(0); return LATIN1.decode(z < 0 ? b : b.subarray(0, z)); }
}

/** A problem that stops the walk of the current object. */
class Unreadable extends Error {}

/** Steps over the tracks from `o` to `end` (an object's end). */
function skipTracks(b: Bytes, o: number, end: number, where: string) {
  while (o < end) {
    if (!b.has(o, 16) || o + 16 > end) throw new Unreadable(`${where}: a track at ${o} runs past its object`);
    const tag = b.tag(o), size = TRACK_VALUE[tag];
    if (!size) throw new Unreadable(`${where}: unknown track ${JSON.stringify(tag)} at ${o}`);
    const count = b.u32(o + 4), interp = b.u32(o + 8);
    if (interp > 3) throw new Unreadable(`${where}: track ${tag} has interpolation ${interp}`);
    const per = 4 + size * (interp > 1 ? 3 : 1);
    if (count > (end - o - 16) / per) throw new Unreadable(`${where}: track ${tag} of ${count} keys doesn't fit`);
    o += 16 + count * per;
  }
}

interface NodeAt { chunk: string; id: number; parent: number; name: string }

/** The nodes of a node chunk (version 800 layouts), in file order. */
function readNodes(b: Bytes, tag: string, start: number, end: number, out: NodeAt[]) {
  /** A node at `p` (its size counts itself); where it ends. */
  const node = (p: number, limit: number): number => {
    const size = b.has(p, 4) ? b.u32(p) : 0;
    if (size < 96 || p + size > limit) throw new Unreadable(`${tag} node at ${p}: size ${size}`);
    const name = b.str(p + 4, 80);
    out.push({ chunk: tag, name, id: b.u32(p + 84), parent: b.i32(p + 88) });
    skipTracks(b, p + 96, p + size, `${tag} node ${JSON.stringify(name)}`);
    return p + size;
  };
  let o = start;
  while (o < end) {
    if (tag === "BONE" || tag === "HELP" || tag === "EVTS" || tag === "CLID") {
      o = node(o, end);
      if (tag === "BONE") o += 8; // geoset id, geoset animation id
      else if (tag === "EVTS" && b.has(o, 4) && b.tag(o) === "KEVT") o += 12 + (b.has(o, 12) ? b.u32(o + 4) * 4 : 0);
      else if (tag === "CLID") o += 4 + (!b.has(o, 4) ? 0 : b.u32(o) === 2 ? 16 : b.u32(o) === 3 ? 28 : 24);
    } else {
      // Objects with a size of their own around the node.
      const size = b.has(o, 4) ? b.u32(o) : 0;
      if (size < 100 || o + size > end) throw new Unreadable(`${tag} object at ${o}: size ${size}`);
      node(o + 4, o + size);
      o += size;
    }
  }
  if (o !== end) throw new Unreadable(`${tag} runs ${o - end} bytes past its chunk`);
}

/** Checks an MDX file as Classic graphics would read it (see the top). */
export function checkClassicModel(bytes: Uint8Array, opts: ClassicCheckOptions = {}): ClassicCheck {
  const b = new Bytes(bytes);
  const errors: string[] = [], warnings: string[] = [];
  const out = () => ({ errors, warnings });
  if (!b.has(0, 4) || b.tag(0) !== "MDLX") return { errors: ["not an MDX file (no MDLX)"], warnings };
  const chunks: { tag: string; start: number; end: number }[] = [];
  for (let o = 4; o < bytes.length;) {
    const size = b.has(o, 8) ? b.u32(o + 4) : 0;
    if (!b.has(o, 8) || !b.has(o + 8, size)) return { errors: [`chunk at ${o} runs past the end of the file`], warnings };
    chunks.push({ tag: b.tag(o), start: o + 8, end: o + 8 + size });
    o += 8 + size;
  }
  const one = (tag: string) => chunks.find((c) => c.tag === tag);
  const vers = one("VERS");
  const version = vers && vers.end - vers.start === 4 ? b.u32(vers.start) : -1;
  if (version !== 800) return { errors: [`version ${version}, not 800`], warnings };
  for (const c of chunks) if (!CLASSIC_CHUNKS.has(c.tag)) warnings.push(`chunk ${c.tag} isn't one of version 800`);
  const modl = one("MODL");
  if (!modl || modl.end - modl.start !== 372) errors.push(modl ? `MODL is ${modl.end - modl.start} bytes, not 372` : "no MODL chunk");
  for (const t of ["SEQS", "MTLS", "GEOS"]) if (!one(t)) warnings.push(`no ${t} chunk`);

  // Sequences: a doodad, unit or destructable plays one (Stand).
  const seqs = one("SEQS");
  if (seqs) {
    const n = (seqs.end - seqs.start) / 132;
    if (!Number.isInteger(n)) errors.push(`SEQS is ${seqs.end - seqs.start} bytes, not sequences of 132`);
    else if (!n) warnings.push("no sequence");
    for (let i = 0; i < Math.floor(n); i++) {
      const o = seqs.start + i * 132;
      if (b.u32(o + 84) < b.u32(o + 80)) warnings.push(`sequence ${JSON.stringify(b.str(o, 80))} ends before it starts`);
    }
  }

  // Textures.
  const texs = one("TEXS");
  const textures: { replaceable: number; path: string }[] = [];
  if (texs) {
    if ((texs.end - texs.start) % 268) errors.push(`TEXS is ${texs.end - texs.start} bytes, not textures of 268`);
    for (let o = texs.start; o + 268 <= texs.end; o += 268) textures.push({ replaceable: b.u32(o), path: b.str(o + 4, 260) });
  }
  for (const t of textures) {
    if (t.replaceable) continue;
    if (!t.path) { warnings.push("a texture has neither a path nor a replaceable id"); continue; }
    if (!/\.blp$/i.test(t.path)) warnings.push(`texture ${t.path} isn't a BLP`);
    if (/^[a-z]:|^[/\\]/i.test(t.path)) warnings.push(`texture ${t.path} is a path on a disk`);
    if (opts.hasTexture && !opts.hasTexture(t.path.replace(/\//g, "\\"))) warnings.push(`texture ${t.path} is not in the map`);
  }

  // Materials: size, priority plane, flags, LAYS and its count, layers of 28 bytes and their tracks.
  let materials = 0;
  const mtls = one("MTLS");
  if (mtls) {
    try {
      for (let o = mtls.start; o < mtls.end; materials++) {
        const where = `material ${materials}`;
        const size = b.has(o, 4) ? b.u32(o) : 0;
        if (size < 20 || o + size > mtls.end) throw new Unreadable(`${where}: size ${size}`);
        const mEnd = o + size;
        if (b.tag(o + 12) !== "LAYS") throw new Unreadable(`${where}: no LAYS where version 800 has it`);
        const layers = b.u32(o + 16);
        if (!layers) warnings.push(`${where} has no layer`);
        let p = o + 20;
        for (let l = 0; l < layers; l++) {
          const lSize = b.has(p, 4) ? b.u32(p) : 0;
          if (lSize < 28 || p + lSize > mEnd) throw new Unreadable(`${where} layer ${l}: size ${lSize}`);
          if (b.u32(p + 4) > 6) warnings.push(`${where} layer ${l}: filter mode ${b.u32(p + 4)}`);
          if (b.u32(p + 12) >= textures.length) warnings.push(`${where} layer ${l}: texture ${b.u32(p + 12)} of ${textures.length}`);
          skipTracks(b, p + 28, p + lSize, `${where} layer ${l}`);
          p += lSize;
        }
        if (p !== mEnd) throw new Unreadable(`${where}: ${mEnd - p} bytes after its layers`);
        o = mEnd;
      }
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      errors.push(e.message);
    }
  }

  // Nodes: ids 0…n-1 in the order of the node chunks, parents among them, a pivot each.
  const nodes: NodeAt[] = [];
  let lastRank = -1;
  for (const c of chunks) {
    const rank = NODE_ORDER.indexOf(c.tag);
    if (rank < 0) continue;
    if (rank < lastRank) warnings.push(`node chunk ${c.tag} comes after ${NODE_ORDER[lastRank]}`);
    lastRank = Math.max(lastRank, rank);
    try { readNodes(b, c.tag, c.start, c.end, nodes); } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      errors.push(e.message);
    }
  }
  nodes.forEach((n, i) => {
    if (n.id !== i) warnings.push(`node ${JSON.stringify(n.name)} (${n.chunk}) has object id ${n.id} where ${i} is next`);
    if (n.parent !== -1 && (n.parent < 0 || n.parent >= nodes.length || n.parent === n.id)) warnings.push(`node ${JSON.stringify(n.name)} has parent ${n.parent}`);
  });
  const ids = new Set(nodes.map((n) => n.id));
  const pivt = one("PIVT");
  if (pivt && (pivt.end - pivt.start) % 12) errors.push(`PIVT is ${pivt.end - pivt.start} bytes, not pivots of 12`);
  const pivots = pivt ? Math.floor((pivt.end - pivt.start) / 12) : 0;
  if (pivots < nodes.length) warnings.push(`${pivots} pivots for ${nodes.length} nodes`);

  // Geosets.
  let geosets = 0;
  const geos = one("GEOS");
  if (geos) {
    for (let o = geos.start; o < geos.end; geosets++) {
      const where = `geoset ${geosets}`;
      const size = b.has(o, 4) ? b.u32(o) : 0;
      if (size < 4 || o + size > geos.end) { errors.push(`${where}: size ${size}`); break; }
      const gEnd = o + size;
      try { checkGeoset(b, o + 4, gEnd, where, { materials, ids, warnings }); } catch (e) {
        if (!(e instanceof Unreadable)) throw e;
        errors.push(e.message);
      }
      o = gEnd;
    }
    if (!geosets) warnings.push("no geoset");
  }

  // Geoset animations.
  const geoa = one("GEOA");
  if (geoa) {
    try {
      for (let o = geoa.start; o < geoa.end;) {
        const size = b.has(o, 4) ? b.u32(o) : 0;
        if (size < 28 || o + size > geoa.end) throw new Unreadable(`geoset animation at ${o}: size ${size}`);
        const g = b.u32(o + 24);
        if (g >= geosets) warnings.push(`geoset animation for geoset ${g} of ${geosets}`);
        skipTracks(b, o + 28, o + size, `geoset animation for geoset ${g}`);
        o += size;
      }
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      errors.push(e.message);
    }
  }
  return out();
}

/** A version 800 geoset from `p` (after its size) to `end`. */
function checkGeoset(b: Bytes, p: number, end: number, where: string, at: { materials: number; ids: Set<number>; warnings: string[] }) {
  const { warnings } = at;
  /** A tagged block of values of `each` bytes at `p`: where its values start and how many; `p` moves past it. */
  const block = (tag: string, each: number) => {
    if (!b.has(p, 8) || b.tag(p) !== tag) throw new Unreadable(`${where}: ${tag} expected at ${p}`);
    const n = b.u32(p + 4);
    if (n > (end - p - 8) / each) throw new Unreadable(`${where}: ${tag} of ${n} doesn't fit`);
    const start = p + 8;
    p = start + n * each;
    return { start, n };
  };
  const nv = block("VRTX", 12).n;
  if (block("NRMS", 12).n !== nv) throw new Unreadable(`${where}: its normals don't match its ${nv} vertices`);
  const types = block("PTYP", 4);
  for (let i = 0; i < types.n; i++) if (b.u32(types.start + i * 4) !== 4) warnings.push(`${where}: primitive type ${b.u32(types.start + i * 4)} (triangles are 4)`);
  const counts = block("PCNT", 4);
  let total = 0;
  for (let i = 0; i < counts.n; i++) total += b.u32(counts.start + i * 4);
  const faces = block("PVTX", 2);
  if (total !== faces.n) throw new Unreadable(`${where}: primitive counts add up to ${total}, PVTX holds ${faces.n}`);
  let maxIndex = 0;
  for (let i = 0; i < faces.n; i++) maxIndex = Math.max(maxIndex, b.u16(faces.start + i * 2));
  if (faces.n && maxIndex >= nv) throw new Unreadable(`${where}: a face uses vertex ${maxIndex} of ${nv}`);
  if (!faces.n) warnings.push(`${where} has no faces`);
  const vertexGroups = block("GNDX", 1), sizes = block("MTGC", 4), matrices = block("MATS", 4);
  if (vertexGroups.n !== nv) warnings.push(`${where}: ${vertexGroups.n} vertex groups for ${nv} vertices`);
  let maxGroup = 0;
  for (let i = 0; i < vertexGroups.n; i++) maxGroup = Math.max(maxGroup, b.u8[vertexGroups.start + i]);
  if (vertexGroups.n && maxGroup >= sizes.n) warnings.push(`${where}: a vertex uses matrix group ${maxGroup} of ${sizes.n}`);
  let sum = 0;
  for (let i = 0; i < sizes.n; i++) sum += b.u32(sizes.start + i * 4);
  if (sum !== matrices.n) warnings.push(`${where}: its matrix groups hold ${sum} matrices, MATS ${matrices.n}`);
  for (let i = 0; i < matrices.n; i++) {
    const id = b.u32(matrices.start + i * 4);
    if (!at.ids.has(id)) { warnings.push(`${where}: a matrix names node ${id}, which isn't there`); break; }
  }
  // Material, selection group and flags, the extent, the per-sequence extents.
  if (!b.has(p, 44) || p + 44 > end) throw new Unreadable(`${where} is cut off after MATS`);
  if (b.u32(p) >= at.materials) warnings.push(`${where}: material ${b.u32(p)} of ${at.materials}`);
  p += 40;
  const extents = b.u32(p);
  if (extents > (end - p - 4) / 28) throw new Unreadable(`${where}: ${extents} sequence extents don't fit`);
  p += 4 + extents * 28;
  // UVAS n (a count, no values), then n UVBS blocks of one pair per vertex.
  if (!b.has(p, 8) || b.tag(p) !== "UVAS") throw new Unreadable(`${where}: UVAS expected at ${p}`);
  const sets = b.u32(p + 4);
  p += 8;
  if (!sets) warnings.push(`${where} has no texture coordinates`);
  for (let s = 0; s < sets; s++) {
    const uv = block("UVBS", 8);
    if (uv.n !== nv) warnings.push(`${where}: UV set ${s} has ${uv.n} pairs for ${nv} vertices`);
  }
  if (p !== end) throw new Unreadable(`${where}: ${end - p} bytes after its texture coordinates`);
}
