// war3map.w3e as text (project file war3map.w3e.txt): one grid per field, rows from north
// to south. Same text as crates/w3proj/src/w3e.rs, which documents the format.

/** Project paths of the terrain, binary or text. */
export const TERRAIN_PATHS = ["map/war3map.w3e", "map/war3map.w3e.txt"];

/** The project's terrain file (case-insensitive), or null. */
export function terrainPath(projectFiles: readonly string[]): string | null {
  const have = new Set(projectFiles.map((p) => p.toLowerCase()));
  return TERRAIN_PATHS.find((p) => have.has(p)) ?? null;
}

export const isTerrainText = (path: string) => path.toLowerCase().endsWith(".w3e.txt");

/** The w3e bytes of a terrain file in either form. */
export async function readTerrainBytes(path: string, file: { readText(): Promise<string>; readBytes(): Promise<Uint8Array> }): Promise<Uint8Array> {
  return isTerrainText(path) ? w3eFromText(await file.readText()) : file.readBytes();
}

/** Writes w3e bytes to a terrain file in its form. */
export async function writeTerrainBytes(path: string, bytes: Uint8Array, file: { writeText(t: string): Promise<void>; writeBytes(b: Uint8Array): Promise<void> }): Promise<void> {
  return isTerrainText(path) ? file.writeText(w3eToText(bytes)) : file.writeBytes(bytes);
}

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";

interface Raw {
  height: number; water: number; texture: number; flags: number; textureBits: number;
  variation: number; cliffVariation: number; cliffTexture: number; layer: number;
}

interface Field {
  name: string;
  numbers: boolean;
  /** Largest value of a character grid; range of a number grid. */
  max: number;
  min?: number;
  get(c: Raw): number;
  set(c: Raw, v: number): void;
}

const FIELDS: Field[] = [
  { name: "height", numbers: true, min: -0x8000 - 0x2000, max: 0x7fff - 0x2000, get: (c) => c.height - 0x2000, set: (c, v) => { c.height = v + 0x2000; } },
  { name: "water", numbers: true, min: -0x2000, max: 0x3fff - 0x2000, get: (c) => (c.water & 0x3fff) - 0x2000, set: (c, v) => { c.water = (c.water & 0xc000) | (v + 0x2000); } },
  { name: "water-bits", numbers: false, max: 3, get: (c) => c.water >> 14, set: (c, v) => { c.water = (c.water & 0x3fff) | (v << 14); } },
  { name: "texture", numbers: false, max: 63, get: (c) => c.texture, set: (c, v) => { c.texture = v; } },
  { name: "variation", numbers: false, max: 31, get: (c) => c.variation, set: (c, v) => { c.variation = v; } },
  { name: "cliff-variation", numbers: false, max: 7, get: (c) => c.cliffVariation, set: (c, v) => { c.cliffVariation = v; } },
  { name: "cliff-texture", numbers: false, max: 15, get: (c) => c.cliffTexture, set: (c, v) => { c.cliffTexture = v; } },
  { name: "layer", numbers: false, max: 15, get: (c) => c.layer, set: (c, v) => { c.layer = v; } },
  { name: "flags", numbers: false, max: 15, get: (c) => c.flags, set: (c, v) => { c.flags = v; } },
  { name: "texture-bits", numbers: false, max: 63, get: (c) => c.textureBits, set: (c, v) => { c.textureBits = v; } },
];

const fail = (m: string): never => { throw new Error(`war3map.w3e: ${m}`); };
const printable = (code: number) => code > 0x20 && code < 0x7f;

function floatText(v: number, bits: number): string {
  return Number.isInteger(v) && Math.abs(v) < 1e7 && !Object.is(v, -0) ? String(v) : `bits:${bits.toString(16).padStart(8, "0")}`;
}

export function w3eToText(buf: Uint8Array): string {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o: number) => { if (o + 4 > buf.length) fail("truncated"); return dv.getUint32(o, true); };
  if (String.fromCharCode(...buf.subarray(0, 4)) !== "W3E!") fail("missing W3E! header");
  const version = u32(4);
  if (version !== 11 && version !== 12) fail(`unsupported version ${version}`);
  if (!printable(buf[8])) fail("tileset isn't a printable character");
  const customTilesets = u32(9);
  let p = 13;
  const list = () => {
    const n = u32(p), ids: string[] = [];
    p += 4;
    if (p + n * 4 > buf.length) fail("truncated tile list");
    for (let i = 0; i < n; i++, p += 4) {
      const id = buf.subarray(p, p + 4);
      // Unprintable ids (e.g. four zero bytes in (10)DustwallowKeys) as hex: always 12 characters.
      ids.push(id.every(printable) ? String.fromCharCode(...id) : `hex:${[...id].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
    }
    return ids.join(" ");
  };
  const ground = list(), cliffs = list();
  const width = u32(p), height = u32(p + 4), ox = u32(p + 8), oy = u32(p + 12);
  p += 16;
  const per = version === 12 ? 8 : 7, n = width * height;
  if (p + n * per > buf.length) fail(`truncated: ${width}×${height} corners`);
  const corners: Raw[] = new Array(n);
  for (let i = 0; i < n; i++, p += per) {
    let texture: number, flags: number, textureBits = 0;
    if (version === 12) {
      const t = dv.getUint16(p + 4, true);
      texture = t & 0x3f; flags = (t >> 6) & 0xf; textureBits = t >> 10;
    } else {
      texture = buf[p + 4] & 0xf; flags = buf[p + 4] >> 4;
    }
    corners[i] = {
      height: dv.getInt16(p, true), water: dv.getUint16(p + 2, true), texture, flags, textureBits,
      variation: buf[p + per - 2] & 0x1f, cliffVariation: buf[p + per - 2] >> 5,
      cliffTexture: buf[p + per - 1] >> 4, layer: buf[p + per - 1] & 0xf,
    };
  }
  const f32 = (bits: number) => new Float32Array(new Uint32Array([bits]).buffer)[0];
  const out = [
    `W3E version ${version}`, `tileset ${String.fromCharCode(buf[8])}`, `custom-tilesets ${customTilesets}`,
    `ground ${ground}`, `cliffs ${cliffs}`, `corners ${width} ${height}`,
    `offset ${floatText(f32(ox), ox)} ${floatText(f32(oy), oy)}`,
  ];
  for (const f of FIELDS) {
    const values = corners.map(f.get);
    if (f.name === "texture-bits" && (version !== 12 || values.every((v) => v === 0))) continue;
    out.push("");
    if (values.length && values.every((v) => v === values[0])) {
      out.push(`[${f.name}] all ${f.numbers ? values[0] : DIGITS[values[0]]}`);
      continue;
    }
    out.push(`[${f.name}]`);
    for (let y = height - 1; y >= 0; y--) {
      const row = values.slice(y * width, (y + 1) * width);
      if (!f.numbers) { out.push(row.map((v) => DIGITS[v]).join("")); continue; }
      const tokens: string[] = [];
      for (let i = 0; i < row.length;) {
        let run = 1;
        while (i + run < row.length && row[i + run] === row[i]) run++;
        if (run >= 3) tokens.push(`${row[i]}*${run}`);
        else for (let k = 0; k < run; k++) tokens.push(String(row[i]));
        i += run;
      }
      out.push(tokens.join(" "));
    }
  }
  if (p < buf.length) out.push("", "[trailer]", [...buf.subarray(p)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return out.join("\n") + "\n";
}

export function w3eFromText(text: string): Uint8Array {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "" && !l.startsWith("#"));
  let li = 0;
  const head = new Map<string, string>();
  for (; li < lines.length && !lines[li].startsWith("["); li++) {
    const l = lines[li], sp = l.indexOf(" ");
    head.set(sp < 0 ? l : l.slice(0, sp), sp < 0 ? "" : l.slice(sp + 1).trim());
  }
  const key = (k: string) => head.get(k) ?? fail(`missing "${k}"`);
  const vm = /^version (\d+)$/.exec(key("W3E"));
  const version = vm ? Number(vm[1]) : fail('bad "W3E version" line');
  if (version !== 11 && version !== 12) fail(`unsupported version ${version}`);
  const tileset = key("tileset");
  if (tileset.length !== 1) fail("tileset must be one character");
  const uint = (s: string, what: string) => /^\d+$/.test(s) && Number(s) <= 0xffffffff ? Number(s) : fail(`bad ${what}`);
  const customTilesets = uint(key("custom-tilesets"), "custom-tilesets");
  const ids = (k: string) => key(k).split(/\s+/).filter(Boolean).map((id) => {
    if (id.length === 4) return id;
    const hex = /^hex:([0-9a-f]{8})$/i.exec(id);
    return hex ? String.fromCharCode(...hex[1].match(/../g)!.map((b) => parseInt(b, 16))) : fail(`tile id "${id}" isn't 4 characters or hex:XXXXXXXX`);
  });
  const ground = ids("ground"), cliffs = ids("cliffs");
  const size = key("corners").split(/\s+/);
  if (size.length !== 2) fail('"corners" needs width and height');
  const width = uint(size[0], "width"), height = uint(size[1], "height");
  const off = key("offset").split(/\s+/);
  if (off.length !== 2) fail('"offset" needs x and y');
  const floatBits = (s: string) => {
    const dv = new DataView(new ArrayBuffer(4));
    if (s.startsWith("bits:")) {
      if (!/^[0-9a-fA-F]{1,8}$/.test(s.slice(5))) fail(`bad offset ${s}`);
      dv.setUint32(0, parseInt(s.slice(5), 16));
    } else {
      if (!/^[+-]?\d+$/.test(s)) fail(`bad offset ${s}`);
      dv.setFloat32(0, Number(s));
    }
    return dv.getUint32(0);
  };
  const offset = [floatBits(off[0]), floatBits(off[1])];
  const n = width * height;
  if (n > 1 << 24) fail("map too large");
  const corners: Raw[] = Array.from({ length: n }, () => ({ height: 0, water: 0, texture: 0, flags: 0, textureBits: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, layer: 0 }));
  const seen = new Set<string>();
  let trailer: number[] = [];
  while (li < lines.length) {
    const l = lines[li++];
    const m = /^\[([^\]]*)\](.*)$/.exec(l) ?? fail(`expected a [section], found "${l}"`);
    const name = m[1];
    if (seen.has(name)) fail(`[${name}] appears twice`);
    seen.add(name);
    if (name === "trailer") {
      const hex = li < lines.length && !lines[li].startsWith("[") ? lines[li++].replace(/\s/g, "") : "";
      if (!/^([0-9a-fA-F]{2})*$/.test(hex)) fail("bad trailer hex");
      trailer = (hex.match(/../g) ?? []).map((b) => parseInt(b, 16));
      continue;
    }
    const f = FIELDS.find((x) => x.name === name) ?? fail(`unknown section [${name}]`);
    const digit = (c: string) => { const v = DIGITS.indexOf(c); return c.length === 1 && v >= 0 && v <= f.max ? v : fail(`'${c}' isn't a value from 0 to ${f.max}`); };
    const value = (s: string) => {
      if (!f.numbers) return s.length === 1 ? digit(s) : fail(`[${name}]: bad value "${s}"`);
      const v = /^[+-]?\d+$/.test(s) ? Number(s) : NaN;
      return v >= f.min! && v <= f.max ? v : fail(`[${name}]: bad value "${s}"`);
    };
    const all = /^\s*all (.*)$/.exec(m[2]);
    if (all) {
      const v = value(all[1].trim());
      for (const c of corners) f.set(c, v);
      continue;
    }
    for (let y = height - 1; y >= 0; y--) {
      if (li >= lines.length || lines[li].startsWith("[")) fail(`[${name}] has fewer than ${height} rows`);
      const row = lines[li++];
      const values: number[] = [];
      if (f.numbers) {
        for (const tok of row.split(/\s+/).filter(Boolean)) {
          const star = tok.indexOf("*");
          let count = 1;
          if (star >= 0) {
            count = /^\d+$/.test(tok.slice(star + 1)) ? Number(tok.slice(star + 1)) : 0;
            if (count < 1 || count > width) fail(`[${name}]: bad run "${tok}"`);
          }
          const v = value(star >= 0 ? tok.slice(0, star) : tok);
          for (let k = 0; k < count; k++) values.push(v);
        }
      } else {
        for (const c of row.trim()) values.push(digit(c));
      }
      if (values.length !== width) fail(`[${name}] row ${height - y} has ${values.length} values, expected ${width}`);
      values.forEach((v, x) => f.set(corners[y * width + x], v));
    }
  }
  for (const f of FIELDS) if (!seen.has(f.name) && f.name !== "texture-bits") fail(`missing [${f.name}]`);
  if (version === 11 && seen.has("texture-bits")) fail("[texture-bits] needs version 12");
  if (version === 11 && corners.some((c) => c.texture > 15)) fail("version 11 holds textures 0–15 only");

  const per = version === 12 ? 8 : 7;
  const out = new Uint8Array(13 + 8 + (ground.length + cliffs.length) * 4 + 16 + n * per + trailer.length);
  const dv = new DataView(out.buffer);
  const id = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  id(0, "W3E!");
  dv.setUint32(4, version, true);
  out[8] = tileset.charCodeAt(0);
  dv.setUint32(9, customTilesets, true);
  let p = 13;
  for (const list of [ground, cliffs]) {
    dv.setUint32(p, list.length, true);
    p += 4;
    for (const s of list) { id(p, s); p += 4; }
  }
  dv.setUint32(p, width, true);
  dv.setUint32(p + 4, height, true);
  dv.setUint32(p + 8, offset[0], true);
  dv.setUint32(p + 12, offset[1], true);
  p += 16;
  for (const c of corners) {
    dv.setInt16(p, c.height, true);
    dv.setUint16(p + 2, c.water, true);
    if (version === 12) dv.setUint16(p + 4, c.texture | (c.flags << 6) | (c.textureBits << 10), true);
    else out[p + 4] = c.texture | (c.flags << 4);
    out[p + per - 2] = c.variation | (c.cliffVariation << 5);
    out[p + per - 1] = (c.cliffTexture << 4) | c.layer;
    p += per;
  }
  out.set(trailer, p);
  return out;
}
