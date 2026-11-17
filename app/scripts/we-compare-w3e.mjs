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
 * the offsets themselves, sorted. Two runs of one setting have the same set when the corners are many enough; with few
 * corners a rare offset may be drawn in one run and not the other (a false DIFFERS of `values` and `count`).
 */
export function heightSpread(buf, base = 0) {
  const { corners } = readW3e(buf);
  const seen = new Set();
  for (const c of Object.values(corners)) seen.add(c.ground - base);
  const values = [...seen].sort((a, b) => a - b);
  return { count: values.length, min: values[0], max: values.at(-1), values };
}

/** The offsets one Noise stamp can leave: whole steps of 25.6 stored units, rounded down, from -10 to 10 (not 0). */
const NOISE_LATTICE = new Set(Array.from({ length: 21 }, (_, i) => Math.floor((i - 10) * 25.6)).filter((v) => v !== 0));

/**
 * What a Noise click did, without the randomness (every corner draws its own step): whether every changed corner is on
 * the step lattice of one stamp (`lattice`), whether any went past one stamp's 256 (`beyondOneStamp`: a second stamp),
 * the longer side of the box round the changed corners in corners (`span`: the four corners at the brush's ends all
 * staying 0 has a chance of about two in a million), and how many corners changed (`changed`; compare with a
 * tolerance: each corner stays 0 by chance one time in 21).
 */
export function noiseView(buf) {
  const { corners } = readW3e(buf);
  let n = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, lattice = true, beyond = false;
  for (const [key, c] of Object.entries(corners)) {
    if (c.ground === 0) continue;
    const [x, y] = key.split(",").map(Number);
    n++;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (!NOISE_LATTICE.has(c.ground)) lattice = false;
    if (Math.abs(c.ground) > 256) beyond = true;
  }
  return { lattice, beyondOneStamp: beyond, span: n ? Math.max(maxX - minX, maxY - minY) + 1 : 0, changed: n };
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
 *  at 15 to 35 corners and each rare one at 1 to 3). Flaky at the edge: a value worn by about 5% of the corners can
 *  fall on either side of the cut in two random draws (a false DIFFERS; rerun before reading it as a finding). */
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

/** war3map.doo (doodads and destructables) as the codecs' JSON, reduced to which ones are left and where, by the 64 square
 *  they stand in (the editor snaps what it opens to its doodad grid: 64, a 2x2 pathing one 32 further), sorted: for runs
 *  that delete the objects a click picks (doodad-pick-we). A doodad within a unit or so of a square's edge can land in
 *  either square in the two saves (a false DIFFERS: look at the positions before reading it as a finding). */
export function doodadPlaces(json) {
  return { doodads: (json.doodads ?? []).map((d) => ({ id: d.id, x: Math.floor(d.position[0] / 64), y: Math.floor(d.position[1] / 64) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.x - b.x || a.y - b.y)) };
}

/** A minimap picture (war3mapMap.blp decoded: { width, height, rgba }) reduced to the mean colour of each `block` x
 *  `block` square, rounded: the two editors' JPEGs and grain never agree pixel by pixel, which tile colour lies where
 *  does (compared with a spec's "tolerance" per channel). Keys "bx,by", rows from the top. */
export function minimapView(image, block = 16) {
  const { width, height, rgba } = image;
  // An empty picture has no blocks: two of them would compare equal, whatever was saved.
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new Error(`the minimap picture is ${width}x${height}: nothing to compare`);
  if (!rgba || rgba.length < width * height * 4) throw new Error(`the minimap picture ${width}x${height} has ${rgba?.length ?? 0} bytes of colour, not ${width * height * 4}`);
  const blocks = {};
  for (let by = 0; by * block < height; by++) {
    for (let bx = 0; bx * block < width; bx++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = by * block; y < Math.min(height, (by + 1) * block); y++) {
        for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x++, n++) for (let k = 0; k < 3; k++) sum[k] += rgba[(y * width + x) * 4 + k];
      }
      blocks[`${bx},${by}`] = sum.map((s) => Math.round(s / n));
    }
  }
  return { size: [width, height], blocks };
}

/** war3mapUnits.doo as the codecs' JSON, reduced to how its objects are numbered, for runs that place a different number
 *  of objects at random spots (a scatter fill against the editor's pastes): whether every editor id is its own, whether
 *  they run 0, 1, 2, … in file order, and the kinds of object there (id, and a random object's type, group and position),
 *  not how many of each nor where. `minCount` (a spec's "minCount"): also whether the file holds at least that many
 *  objects, so a paste or fill that placed nothing on one side differs (both sides' numbers may differ above it). */
export function unitIds(json, minCount = null) {
  const units = json.units ?? [];
  const ids = units.map((u) => u.editorId);
  const kind = (u) => (!/^[uib]DNR$/.test(u.id) ? u.id
    : u.randomType === 1 ? `${u.id} group ${u.randomGroup} position ${u.randomPosition}` : `${u.id} random type ${u.randomType}`);
  return {
    editorIdsUnique: new Set(ids).size === ids.length,
    editorIdsInOrder: ids.every((n, i) => n === i),
    kinds: [...new Set(units.map(kind))].sort(),
    ...(minCount ? { [`atLeast${minCount}Objects`]: units.length >= minCount } : {}),
  };
}

/** war3map.wpm ("MP3W", version, width, height, a flag byte per cell, rows from the bottom) as { version, size,
 *  cells: { "x,y": flags } } for diffJson, so a spec can name the cells that differ ("cells.12,40") in expectPaths
 *  instead of the plain `wpm` kind's "something differs". Throws on a file that isn't a whole pathing map. */
export function wpmCells(buf) {
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "MP3W") throw new Error("not a wpm file (missing MP3W header)");
  const version = buf.readUInt32LE(4), w = buf.readUInt32LE(8), h = buf.readUInt32LE(12);
  if (buf.length !== 16 + w * h) throw new Error(`a wpm of ${w}x${h} cells has ${buf.length - 16} bytes of cells`);
  const cells = {};
  for (let i = 0; i < w * h; i++) cells[`${i % w},${Math.floor(i / w)}`] = buf[16 + i];
  return { version, size: [w, h], cells };
}

/** Per kind of "w3e…" compare: the parsed form of one save. */
export function w3eView(kind, buf) {
  if (kind === "w3e") return readW3e(buf);
  if (kind === "w3e-spread") return heightSpread(buf);
  if (kind === "w3e-noise") return noiseView(buf);
  if (kind === "w3e-variation") return variationView(buf);
  throw new Error(`unknown w3e kind ${kind}`);
}
