// war3map.w3e for we-compare: the binary file read into a form diffJson can compare corner by corner, and the summary
// of ground heights for runs whose result is random (Reset Height Field "Random"). Pure; we-compare.test.mjs tests it.
//
// Layout (version 11, 7 bytes a corner; 12 has 8, its texture word being 16 bits): i16 ground height word (0x2000 =
// level 0), u16 water word (low 14 bits the level, bits 14 and 15 the map edge), u8 texture (low nibble) | flags (high
// nibble: 1 ramp, 2 blight, 4 water, 8 boundary), u8 ground variation (low 5 bits) | cliff variation << 5, u8 cliff
// texture (high nibble) | layer (low nibble). Same as lib/terrain/w3e.ts, which is TypeScript and not read from here.

/** The file as { header, corners: { "x,y": { ... } } }: every stored value of every corner but the two variations (the
 *  editor draws both at random, so two saves never agree on them; `withVariations` adds them). */
export function readW3e(buf, withVariations = false) {
  if (buf.length < 13 || buf.toString("latin1", 0, 4) !== "W3E!") throw new Error("not a w3e file (missing W3E! header)");
  const version = buf.readUInt32LE(4);
  if (version !== 11 && version !== 12) throw new Error(`unsupported w3e version ${version}`);
  let p = 13;
  const list = () => {
    const n = buf.readUInt32LE(p);
    p += 4;
    if (p + n * 4 > buf.length) throw new Error("truncated tile list");
    const out = [];
    for (let i = 0; i < n; i++, p += 4) out.push(buf.toString("latin1", p, p + 4));
    return out;
  };
  const header = { version, tileset: String.fromCharCode(buf[8]), custom: buf.readUInt32LE(9), ground: list(), cliffs: list() };
  const width = buf.readUInt32LE(p), height = buf.readUInt32LE(p + 4);
  header.width = width;
  header.height = height;
  header.offset = [buf.readFloatLE(p + 8), buf.readFloatLE(p + 12)];
  p += 16;
  const per = version === 12 ? 8 : 7;
  if (p + width * height * per > buf.length) throw new Error("truncated corners");
  const corners = {};
  for (let i = 0; i < width * height; i++, p += per) {
    const water = buf.readUInt16LE(p + 2);
    let texture, flags;
    if (version === 12) {
      const t = buf.readUInt16LE(p + 4);
      texture = t & 0x3f;
      flags = (t >> 6) & 0xf;
    } else {
      texture = buf[p + 4] & 0xf;
      flags = buf[p + 4] >> 4;
    }
    corners[`${i % width},${Math.floor(i / width)}`] = {
      ground: buf.readInt16LE(p) - 0x2000,
      water: water & 0x3fff,
      edge: water >> 14,
      texture,
      ramp: flags & 1 ? 1 : 0,
      blight: flags & 2 ? 1 : 0,
      wet: flags & 4 ? 1 : 0,
      boundary: flags & 8 ? 1 : 0,
      ...(withVariations ? { variation: buf[p + per - 2] & 0x1f, cliffVariation: buf[p + per - 2] >> 5 } : {}),
      cliffType: buf[p + per - 1] >> 4,
      layer: buf[p + per - 1] & 0xf,
    };
  }
  return { header, corners };
}

/**
 * What a random height change did, without the randomness: the set of the ground words' offsets from `base` (the
 * input's word, 0 for the flat map), as { count, min, max, values }: how many different offsets, the extremes, and
 * the offsets themselves, sorted. Two runs of one setting have the same set when the corners are many enough.
 */
export function heightSpread(buf, base = 0) {
  const { corners } = readW3e(buf);
  const seen = new Set();
  for (const c of Object.values(corners)) seen.add(c.ground - base);
  const values = [...seen].sort((a, b) => a - b);
  return { count: values.length, min: values[0], max: values.at(-1), values };
}

/**
 * The ground and cliff variations without their randomness: per ground texture, how many corners wear it and which
 * variation values occur (sorted, distinct) with how many corners each (`ground`/`cliff` as value to count; `variationView` leaves the counts
 * out: two draws never agree on them). `ground` is the 5-bit ground variation.
 */
export function variationSpread(buf) {
  const { header, corners } = readW3e(buf, true);
  const out = {};
  for (const c of Object.values(corners)) {
    const t = header.ground[c.texture] ?? `#${c.texture}`;
    const e = (out[t] ??= { corners: 0, ground: {}, cliff: {} });
    e.corners++;
    e.ground[c.variation] = (e.ground[c.variation] ?? 0) + 1;
    e.cliff[c.cliffVariation] = (e.cliff[c.cliffVariation] ?? 0) + 1;
  }
  return out;
}

/** The compared form of variationSpread: the corner counts and the ground variations that at least 5% of a texture's
 *  corners wear (the editor draws a few rare values besides its main ones, a stroke of 149 corners shows the main ones
 *  at 15 to 35 corners and each rare one at 1 to 3). */
export function variationView(buf) {
  const out = {};
  for (const [t, e] of Object.entries(variationSpread(buf))) {
    out[t] = { corners: e.corners, ground: Object.entries(e.ground).filter(([, n]) => n * 20 >= e.corners).map(([v]) => Number(v)).sort((x, y) => x - y) };
  }
  return out;
}

/** war3mapUnits.doo as the codecs' JSON, reduced to where each object stands: id, x, y and the height (z), in file order.
 *  What else differs between the two editors' files (the format version, item tables, hero attributes) isn't compared. */
export function unitHeights(json) {
  return { units: (json.units ?? []).map((u) => ({ id: u.id, x: u.position[0], y: u.position[1], z: u.position[2] })) };
}

/** Per kind of "w3e…" compare: the parsed form of one save. */
export function w3eView(kind, buf) {
  if (kind === "w3e") return readW3e(buf);
  if (kind === "w3e-spread") return heightSpread(buf);
  if (kind === "w3e-variation") return variationView(buf);
  throw new Error(`unknown w3e kind ${kind}`);
}
