// A WebGL2 context for tests that counts what is made and deleted, and a model and a texture file small enough to
// make with it. Nothing is drawn; every call that isn't a create/delete is accepted and gives back something harmless.

export type GlKind = "buffer" | "texture" | "vertexArray" | "program" | "shader";

export interface CountingGl {
  gl: WebGL2RenderingContext;
  /** What was made and not deleted yet, per kind. */
  live: Record<GlKind, Set<object>>;
  /** Every delete of something not live (deleted twice, or never made here), as "kind". */
  bad: string[];
  /** Calls of delete* by kind. */
  deletes: Record<GlKind, number>;
  /** Calls of create* by kind. */
  creates: Record<GlKind, number>;
  /** The state isContextLost() answers. */
  lost: boolean;
  /** The objects live now, to compare with later. */
  snapshot(): Set<object>;
  /** What was made after `before` (a snapshot) and is still live. */
  since(before: Set<object>): object[];
}

const KINDS: GlKind[] = ["buffer", "texture", "vertexArray", "program", "shader"];
const NAMES: Record<string, GlKind> = { Buffer: "buffer", Texture: "texture", VertexArray: "vertexArray", Program: "program", Shader: "shader" };

export function countingGl(): CountingGl {
  const live = Object.fromEntries(KINDS.map((k) => [k, new Set<object>()])) as Record<GlKind, Set<object>>;
  const deletes = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<GlKind, number>;
  const creates = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<GlKind, number>;
  const bad: string[] = [];
  const state = { lost: false };
  const base: Record<string, unknown> = {
    getError: () => 0, getAttribLocation: () => 0, getExtension: () => null, getParameter: () => 16384,
    getUniformLocation: (_p: unknown, name: string) => name, getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => "", getProgramInfoLog: () => "", isContextLost: () => state.lost,
  };
  for (const [name, kind] of Object.entries(NAMES)) {
    base[`create${name}`] = () => { const o = { kind, id: creates[kind]++ }; live[kind].add(o); return o; };
    base[`delete${name}`] = (o: object | null) => {
      if (o === null) return;
      deletes[kind]++;
      if (!live[kind].delete(o)) bad.push(kind);
    };
  }
  const gl = new Proxy(base, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
  const all = () => new Set<object>(KINDS.flatMap((k) => [...live[k]]));
  return {
    gl, live, bad, deletes, creates,
    get lost() { return state.lost; }, set lost(v: boolean) { state.lost = v; },
    snapshot: all,
    since: (before) => [...all()].filter((o) => !before.has(o)),
  };
}

class Bytes {
  parts: number[] = [];
  u32(v: number) { this.parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); return this; }
  f32(v: number) { this.parts.push(...new Uint8Array(new Float32Array([v]).buffer)); return this; }
  u16(v: number) { this.parts.push(v & 255, (v >> 8) & 255); return this; }
  tag(s: string) { this.parts.push(...[...s].map((c) => c.charCodeAt(0))); return this; }
  str(s: string, n: number) { const b = new Array(n).fill(0); [...s].forEach((c, i) => { b[i] = c.charCodeAt(0); }); this.parts.push(...b); return this; }
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
}

/** An MDX of `geosets` triangles (each its own geoset) with one Stand animation and one layer, drawing the texture `texture`. */
export function tinyMdx(texture: string, geosets = 1): Uint8Array {
  const b = new Bytes();
  b.tag("MDLX");
  b.chunk("VERS", () => b.u32(800));
  b.chunk("MODL", () => b.str("Tiny", 80).str("", 260).extent(5, [-1, -2, 0], [1, 2, 3]).u32(150));
  b.chunk("SEQS", () => b.str("Stand", 80).u32(0).u32(1000).f32(0).u32(0).f32(0).u32(0).extent(4, [-1, -1, 0], [1, 1, 2]));
  b.chunk("TEXS", () => b.u32(0).str(texture, 260).u32(0));
  b.chunk("MTLS", () => b.sized(true, () => {
    b.u32(0).u32(0).tag("LAYS").u32(1);
    b.sized(true, () => b.u32(0).u32(0).u32(0).u32(0xffffffff).u32(0).f32(1));
  }));
  b.chunk("GEOS", () => {
    for (let g = 0; g < geosets; g++) {
      b.sized(true, () => {
        b.tag("VRTX").u32(3); [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v) => b.f32(v));
        b.tag("NRMS").u32(3); for (let i = 0; i < 3; i++) b.f32(0).f32(0).f32(1);
        b.tag("PTYP").u32(1).u32(4);
        b.tag("PCNT").u32(1).u32(3);
        b.tag("PVTX").u32(3); [0, 1, 2].forEach((i) => b.u16(i));
        b.tag("GNDX").u32(3); b.parts.push(0, 0, 0);
        b.tag("MTGC").u32(1).u32(3);
        b.tag("MATS").u32(1).u32(0);
        b.u32(0).u32(0).u32(0).extent(1.5, [0, 0, 0], [1, 1, 0.5]).u32(1).extent(1, [0, 0, 0], [1, 1, 1]);
        b.tag("UVAS").u32(1);
        b.tag("UVBS").u32(3); [0, 0, 1, 0, 0, 1].forEach((v) => b.f32(v));
      });
    }
  });
  b.chunk("PIVT", () => [0, 0, 0].forEach((v) => b.f32(v)));
  return new Uint8Array(b.parts);
}

/** A 2x2 uncompressed 32-bit TGA. */
export function tinyTga(): Uint8Array {
  const head = [0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 32, 8];
  return new Uint8Array([...head, ...new Array(16).fill(255)]);
}
