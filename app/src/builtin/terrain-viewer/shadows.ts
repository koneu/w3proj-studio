// war3map.shd: baked ground shadows, one byte per 32×32 cell (the pathing
// grid), 0xFF in shadow, 0x00 lit, rows from the bottom-left; no header.
//
// The World Editor casts them from a fixed sun onto the terrain, plus the
// shadows of doodad models (alpha-tested textures, and only when shadows are
// recalculated, so many maps carry stale ones). We predict terrain shadows
// (97% of cells away from doodads match) and doodad models (opaque and
// alpha-tested parts; 93% of all cells match over 61 maps); on save
// only the cells whose prediction changed since the last save are rewritten
// (`updateShadows`), so everything the World Editor computed is kept.

import type { Model } from "../../lib/model/mdx";
import { groundHeight, rampLift, type Terrain } from "../../lib/terrain/w3e";

/** Direction toward the sun: azimuth (degrees, counter-clockwise from +x)
 *  and elevation above the horizon. */
export interface Sun { azimuth: number; elevation: number }

/** Fitted against the sample maps. */
export const DEFAULT_SUN: Sun = { azimuth: 225, elevation: 30 };

/** The terrain's heights as the World Editor's Calculate Shadows reads them: one per 32×32 cell (the shd grid), at the
 *  cell's centre. Ground tiles: the corners' heights (layers and ramps included) over the tile's two triangles, split
 *  from the top-left to the bottom-right corner. Cliff tiles: `cliffs`' heights for the tile, over the tile's lowest
 *  layer and the ground's own height there; a tile it has none for is taken as ground.
 *  we-drive (branch we-shadow-3, 2026-11-17; make-shadow-probes.mjs shadow-terrain, plateau.w3x; SD and HD alike):
 *  single raised corners of 128, 256 and 512, ridges, banks of 64 and 128 and cliffs of one and two levels, 2618
 *  shadowed cells, all but one as the editor's with these heights and terrainShadows' walk. */
export function shadowCellHeights(t: Terrain, cliffs?: CliffCells): Float32Array {
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const out = new Float32Array(w * h);
  const corner = (x: number, y: number) => t.corners[y * t.width + x];
  const lift = (x: number, y: number) => (corner(x, y).ramp ? rampLift(t, x, y) : 0);
  for (let ty = 0; ty < t.height - 1; ty++) {
    for (let tx = 0; tx < t.width - 1; tx++) {
      const bl = corner(tx, ty), br = corner(tx + 1, ty), tl = corner(tx, ty + 1), tr = corner(tx + 1, ty + 1);
      const isCliff = !(bl.layer === br.layer && bl.layer === tl.layer && bl.layer === tr.layer) && !(bl.ramp && br.ramp && tl.ramp && tr.ramp);
      const cells = isCliff ? cliffs?.(tx, ty) ?? null : null;
      const h00 = bl.height + lift(tx, ty), h10 = br.height + lift(tx + 1, ty), h01 = tl.height + lift(tx, ty + 1), h11 = tr.height + lift(tx + 1, ty + 1);
      const base = (Math.min(bl.layer, br.layer, tl.layer, tr.layer) - 2) * 128;
      const g00 = groundHeight(bl), g10 = groundHeight(br), g01 = groundHeight(tl), g11 = groundHeight(tr);
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const u = (i + 0.5) / 4, v = (j + 0.5) / 4;
          const cliff = cells ? cells[j * 4 + i] : NaN;
          // A cliff model's ground under it: bilinear (real maps: 330 cells off against 367 over the two triangles).
          out[(ty * 4 + j) * w + tx * 4 + i] = Number.isNaN(cliff)
            ? splitTile(h00, h10, h01, h11, u, v)
            : base + cliff + ((g00 * (1 - u) + g10 * u) * (1 - v) + (g01 * (1 - u) + g11 * u) * v);
        }
      }
    }
  }
  return out;
}

/** A height inside a tile from its corners (bottom-left, bottom-right, top-left, top-right), over its two triangles
 *  split from the top-left to the bottom-right corner. */
function splitTile(h00: number, h10: number, h01: number, h11: number, u: number, v: number): number {
  return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

/** A cliff tile's heights for shadowCellHeights: the 16 cell centres (row by row from the south, `v * 4 + u`), in the
 *  model's z over the tile's lowest layer; NaN where none is known; null: none for the tile. */
export type CliffCells = (tileX: number, tileY: number) => Float32Array | null;

/** The variation of shadowCliffName's model a tile takes: its own, counted round the name's `count` variations when
 *  the name has fewer (the drawn model instead falls back to the highest one there is). Real maps (we-drive, branch
 *  we-shadow-3, LastRefuge, TurtleRock and HillsbradCreek without doodads, variations 0 to 2 against names of 1 to 3):
 *  674, 840 and 1646 cells off with the fallback, 367, 576 and 1009 this way (dev's ray: 2950, 4222, 7405); whether a
 *  variation of 3 or more on a name of two goes round to 1 or to 0 isn't told apart there. */
export function shadowCliffVariation(variation: number, count: number): number {
  return count > 0 ? variation % count : 0;
}

/** The model the World Editor's shadow calculation reads for a cliff tile, and how: it names it after the corners read
 *  from the top-left (top-left, top-right, bottom-right, bottom-left; A/B/C as for drawing, cliffs.ts planCliffs), not
 *  from the bottom-left as the drawn model is, and reads that model a quarter turn round, the tile's (u, v) at the
 *  model's (1 - v, u) (cliffCellHeights). The shape is near the drawn one's, the details are the other model's: the
 *  one-level cliff's shadow reaches a cell further in one row of four along an east face. we-drive (branch
 *  we-shadow-3): of the eight name orders against the eight turns only this pair matches the editor; the drawn model as
 *  it is left 129 of the cliff cells wrong. Returns the letters of the name. */
export function shadowCliffName(t: Terrain, tileX: number, tileY: number): string {
  const c = (x: number, y: number) => t.corners[y * t.width + x];
  const order = [c(tileX, tileY + 1), c(tileX + 1, tileY + 1), c(tileX + 1, tileY), c(tileX, tileY)];
  const base = Math.min(...order.map((k) => k.layer));
  return order.map((k) => String.fromCharCode(65 + k.layer - base)).join("");
}

/** shadowCliffName's model's heights at a tile's 16 cell centres (CliffCells): the highest of its triangles over each
 *  point, read a quarter turn round. `positions`/`faces`: the model's triangles in its own space (the tile one tile to
 *  the -x side of its origin, as cliff models are). */
export function cliffCellHeights(positions: ArrayLike<number>, faces: ArrayLike<number>): Float32Array {
  return blockCellHeights(positions, faces, 0, 0);
}

/** The name the shadow calculation gives a ramp side's model (lib/terrain/cliffs.ts rampSides; `outer`: its outer
 *  corners bottom-left, top-left, top-right, bottom-right, `base` their lowest layer): as for cliffs (shadowCliffName),
 *  the corners read from the top-left, A/B/C for cliff corners and L/H/X for ramp corners 0/1/2 layers over the base,
 *  where the drawn model's name starts at the bottom-left (cliffs.ts planCliffs). The model is read a quarter turn round
 *  (rampCellHeights). we-drive (branch we-shadow-4, 2026-11-17; make-shadow-probes.mjs shadow-slopes: a ramp down each
 *  face of a plateau, LastRefuge without doodads): 42 and 114 cells off with the side tiles' cliff models, 28 and 113
 *  with them as ground, 20 and 103 with the drawn ramp model, 11 and 87 so (4 of the 11 aren't the ramps'). */
export function shadowRampName(outer: readonly { layer: number; ramp: boolean }[], base: number): string {
  return [outer[1], outer[2], outer[3], outer[0]].map((c) => (c.ramp ? "LHX" : "ABC")[c.layer - base] ?? "?").join("");
}

/** shadowRampName's model's heights at the 16 cell centres of one tile of its ramp side (CliffCells), over the side's
 *  base layer: the side's point (x, y) (units from its bottom-left corner) at the model's (-y, x), the quarter turn of
 *  cliffCellHeights. `tileX`, `tileY`: the tile's place in the side (0 or 1). */
export function rampCellHeights(positions: ArrayLike<number>, faces: ArrayLike<number>, tileX: number, tileY: number): Float32Array {
  return blockCellHeights(positions, faces, tileX, tileY);
}

/** The highest surface of a model over the 16 cell centres of the tile (tileX, tileY) of a block of tiles, read a quarter
 *  turn round: the block's point (x, y) at the model's (-y, x). */
function blockCellHeights(positions: ArrayLike<number>, faces: ArrayLike<number>, tileX: number, tileY: number): Float32Array {
  const out = new Float32Array(16).fill(NaN);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      // For one tile: its (u, v) at the model's (1 - v, u); the model's x runs from -128 to 0.
      const px = -(tileY * 128 + (j + 0.5) * 32), py = tileX * 128 + (i + 0.5) * 32;
      let best = NaN;
      for (let f = 0; f + 2 < faces.length; f += 3) {
        const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
        const ax = positions[a], ay = positions[a + 1], bx = positions[b], by = positions[b + 1], cx = positions[c], cy = positions[c + 1];
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-9) continue;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        if (w0 < -1e-6 || w1 < -1e-6 || 1 - w0 - w1 < -1e-6) continue;
        const z = w0 * positions[a + 2] + w1 * positions[b + 2] + (1 - w0 - w1) * positions[c + 2];
        if (!(z <= best)) best = z;
      }
      out[j * 4 + i] = best;
    }
  }
  return out;
}

/** Terrain shadows (the World Editor's rule, see shadowCellHeights): from each cell, a walk toward the sun as far as the
 *  map goes, one cell diagonal a step at the default sun; the cell is dark when a cell on the way stands as high as the
 *  cell itself plus the sun's rise over the distance (shadowStepRise) or higher. `cliffs`: the cliff tiles' heights
 *  (without them the cliffs are read as ground between their corners). */
export function terrainShadows(t: Terrain, s: Sun = DEFAULT_SUN, cliffs?: CliffCells): Uint8Array {
  const { out, rows, row } = terrainShadowRows(t, s, shadowCellHeights(t, cliffs));
  for (let cy = 0; cy < rows; cy++) row(cy);
  return out;
}

/** terrainShadows a few rows at a time, for the terrain view (a big map takes a second or two): `pause` is awaited
 *  every few milliseconds of work, and stops the work (rejecting) when it returns false. */
export async function terrainShadowsInSteps(t: Terrain, s: Sun = DEFAULT_SUN, pause: () => Promise<boolean>, cliffs?: CliffCells): Promise<Uint8Array> {
  const { out, rows, row } = terrainShadowRows(t, s, shadowCellHeights(t, cliffs));
  let since = performance.now();
  for (let cy = 0; cy < rows; cy++) {
    row(cy);
    if (performance.now() - since > 8) {
      if (!(await pause())) throw new Error("superseded");
      since = performance.now();
    }
  }
  return out;
}

/** How much the sun rises over one step of the walk (a cell's diagonal, 32√2 units). The editor's walk rises 80/3 a step
 *  at its 30° sun, a little more than tan 30° gives (26.13): its sun is about 30.5° high. we-drive (branch we-shadow-4,
 *  2026-11-17): the cells of real maps whose steepest rise toward the sun (the most any cell on the walk stands over
 *  them, by its step) lies between 26.13 and 26.6 are lit in the editor, those above 26.7 dark (TurtleRock, LastRefuge
 *  and HillsbradCreek without doodads: 534, 330, 857 cells off with tan 30°, 25, 115, 307 with 80/3); the probe map's
 *  cells at exactly 80/3 (a 128 bank read three cells off) are dark. Other elevations scale with their tangent. */
export function shadowStepRise(s: Sun): number {
  return (80 / 3) * (Math.tan((s.elevation * Math.PI) / 180) / Math.tan(Math.PI / 6));
}

function terrainShadowRows(t: Terrain, s: Sun, heights: Float32Array): { out: Uint8Array; rows: number; row: (cy: number) => void } {
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const out = new Uint8Array(w * h);
  // A step: toward the sun, as long as a cell's diagonal (so one cell diagonal at 225°).
  const az = (s.azimuth * Math.PI) / 180;
  const sx = Math.cos(az) * Math.SQRT2, sy = Math.sin(az) * Math.SQRT2, rise = shadowStepRise(s);
  // The walk has no length of its own (HillsbradCreek's shadows reach 28 cells: 307 cells off after 16, 75 after 28 and
  // on); it ends where the sun's ray is over the map's highest cell.
  let top = -Infinity;
  for (const v of heights) if (v > top) top = v;
  const row = (cy: number) => {
    for (let cx = 0; cx < w; cx++) {
      const h0 = heights[cy * w + cx];
      for (let k = 1; h0 + rise * k - 1e-3 <= top; k++) {
        const x = Math.round(cx + sx * k), y = Math.round(cy + sy * k);
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        // Dark at the rise and over it (the probe's cells exactly 80/3 a step up are dark); the margin keeps an exact
        // rise from coming out lit by the floats' last bit.
        if (heights[y * w + x] - h0 >= rise * k - 1e-3) { out[cy * w + cx] = 0xff; break; }
      }
    }
  };
  return { out, rows: h, row };
}

/** Alpha channel of a texture, rows top to bottom. */
export interface AlphaMap {
  width: number;
  height: number;
  alpha: Uint8Array;
}

/** Triangles of a model in its own space. Faces with an alpha map only cast
 *  where the texture is solid (alpha-tested foliage). */
export interface ShadowMesh {
  positions: Float32Array;
  faces: Uint32Array;
  uvs?: Float32Array;
  /** Per face: index into `alphaMaps`, or -1 (solid). */
  faceAlpha?: Int16Array;
  alphaMaps?: AlphaMap[];
}

/** Alpha at or above this casts (World Editor alpha test). */
export const ALPHA_CUTOFF = 192;

/** Filter modes that cast: 0 opaque, 1 alpha-tested ("transparent"). */
const CASTING_MODES = new Set([0, 1]);

/** Texture paths whose alpha decides where a model casts. */
export function alphaTexturePaths(model: Model): string[] {
  const out = new Set<string>();
  for (const g of model.geosets) {
    const layer = model.materials[g.materialId]?.layers[0];
    const tex = layer && model.textures[layer.textureIds[0]];
    if (g.lod === 0 && layer?.filterMode === 1 && tex?.path) out.add(tex.path);
  }
  return [...out];
}

/** The casting triangles of a model's most detailed geosets. `alphaOf`
 *  returns the decoded alpha of an alpha-tested texture (null: treat as solid). */
export function shadowMesh(model: Model, alphaOf: (path: string) => AlphaMap | null): ShadowMesh | null {
  const positions: number[] = [], uvs: number[] = [], faces: number[] = [], faceAlpha: number[] = [];
  const alphaMaps: AlphaMap[] = [], mapIndex = new Map<string, number>();
  for (const g of model.geosets) {
    const layer = model.materials[g.materialId]?.layers[0];
    if (g.lod > 0 || !CASTING_MODES.has(layer?.filterMode ?? 0)) continue;
    let ai = -1;
    const tex = layer && model.textures[layer.textureIds[0]];
    if (layer?.filterMode === 1 && tex?.path) {
      const am = alphaOf(tex.path);
      if (am) {
        if (!mapIndex.has(tex.path)) { mapIndex.set(tex.path, alphaMaps.length); alphaMaps.push(am); }
        ai = mapIndex.get(tex.path)!;
      }
    }
    const base = positions.length / 3;
    positions.push(...g.positions);
    uvs.push(...(g.uvs.length >= (g.positions.length / 3) * 2 ? g.uvs.subarray(0, (g.positions.length / 3) * 2) : new Float32Array((g.positions.length / 3) * 2)));
    for (let i = 0; i < g.faces.length; i += 3) {
      faces.push(base + g.faces[i], base + g.faces[i + 1], base + g.faces[i + 2]);
      faceAlpha.push(ai);
    }
  }
  if (!faces.length) return null;
  return { positions: new Float32Array(positions), faces: new Uint32Array(faces), uvs: new Float32Array(uvs), faceAlpha: new Int16Array(faceAlpha), alphaMaps };
}

/** A placed model: world position (z absolute), radians, per-axis scale. */
export interface ShadowCaster {
  mesh: ShadowMesh;
  x: number;
  y: number;
  z: number;
  angle: number;
  scale: [number, number, number];
}

/** Darkens the cells under a model's shadow. Each cell's line toward the sun (the walk's rise, shadowStepRise) from
 *  its ground (`heights`, shadowCellHeights; without them the corners over the tile's two triangles) meets the model's
 *  triangles: the cell is dark when every surface of the model on that line lies above the ground there; one at or
 *  under the ground (a model's bottom, a rock's underside sunk into it) leaves it lit, the model's own footprint as a
 *  rule. we-drive (branch we-shadow-4, 2026-11-17, HD): box models imported into a map (make-shadow-probes.mjs
 *  shadow-boxes: a closed box on the ground leaves its footprint lit, the same box without its bottom shades it, sunk
 *  into the ground lit, floating over it dark, either way round its triangles turn; of 235 cells the 8 whose centres
 *  lie on a projected triangle's edge are off, 76 when every surface casts); LRrk's ten variations and eight turns 7
 *  cells off (the editor 341; every surface casting: 53), the same in SD 3 (6 at tan 30°); LastRefuge whole 487 of
 *  11050 (971 with the ground under each corner of the model instead of the cell's, 1216 every surface casting).
 *  Whether a texture hole of an alpha-tested face counts as a surface isn't known: it is left out. */
export function castShadow(out: Uint8Array, t: Terrain, c: ShadowCaster, s: Sun = DEFAULT_SUN, heights?: Float32Array) {
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const { positions: pos, faces } = c.mesh;
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  // The model's corners projected along the sun onto the level of its origin (c.z), in cells, and their heights over it.
  const az = (s.azimuth * Math.PI) / 180, slope = shadowStepRise(s) / (32 * Math.SQRT2), ux = Math.cos(az), uy = Math.sin(az);
  const proj = new Float32Array((pos.length / 3) * 2), over = new Float32Array(pos.length / 3);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.length / 3; i++) {
    const lx = pos[i * 3] * c.scale[0], ly = pos[i * 3 + 1] * c.scale[1], lz = pos[i * 3 + 2] * c.scale[2];
    const wx = c.x + lx * ca - ly * sa, wy = c.y + lx * sa + ly * ca, k = lz / slope;
    over[i] = lz;
    const px = (proj[i * 2] = (wx - ux * k - t.offsetX) / 32), py = (proj[i * 2 + 1] = (wy - uy * k - t.offsetY) / 32);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  if (!(minX <= maxX && minY <= maxY)) return;
  // A cell's line meets that level `(ground - c.z) / slope` away from the sun: the cells looked at reach that much
  // further than the projection: MARGIN cells each way, ground up to about 640 over or under the model's origin.
  const MARGIN = 24;
  const bx0 = Math.max(0, Math.floor(minX) - MARGIN), bx1 = Math.min(w - 1, Math.ceil(maxX) + MARGIN);
  const by0 = Math.max(0, Math.floor(minY) - MARGIN), by1 = Math.min(h - 1, Math.ceil(maxY) + MARGIN);
  if (bx0 > bx1 || by0 > by1) return;
  const bw = bx1 - bx0 + 1, n = bw * (by1 - by0 + 1);
  /** Per cell: its ground over c.z, where its line meets c.z's level, the lowest surface on the line over its ground. */
  const ground = new Float32Array(n), meetX = new Float32Array(n), meetY = new Float32Array(n), lowest = new Float32Array(n).fill(Infinity);
  // How far the meeting points stand off the cells' centres, at most and least (a triangle looks that much further).
  let offX0 = Infinity, offX1 = -Infinity, offY0 = Infinity, offY1 = -Infinity;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = (y - by0) * bw + x - bx0;
      const g = (heights ? heights[y * w + x] : cornerGround(t, x, y)) - c.z, d = -g / slope / 32;
      ground[i] = g;
      meetX[i] = x + 0.5 + ux * d;
      meetY[i] = y + 0.5 + uy * d;
      offX0 = Math.min(offX0, ux * d); offX1 = Math.max(offX1, ux * d); offY0 = Math.min(offY0, uy * d); offY1 = Math.max(offY1, uy * d);
    }
  }
  const { uvs, faceAlpha, alphaMaps } = c.mesh;
  for (let f = 0; f < faces.length; f += 3) {
    const ia = faces[f], ib = faces[f + 1], ic = faces[f + 2];
    const ax = proj[ia * 2], ay = proj[ia * 2 + 1];
    const bx = proj[ib * 2], by = proj[ib * 2 + 1];
    const qx = proj[ic * 2], qy = proj[ic * 2 + 1];
    const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const am = faceAlpha && alphaMaps && uvs && faceAlpha[f / 3] >= 0 ? alphaMaps[faceAlpha[f / 3]] : null;
    const x0 = Math.max(bx0, Math.floor(Math.min(ax, bx, qx) - offX1) - 1), x1 = Math.min(bx1, Math.ceil(Math.max(ax, bx, qx) - offX0));
    const y0 = Math.max(by0, Math.floor(Math.min(ay, by, qy) - offY1) - 1), y1 = Math.min(by1, Math.ceil(Math.max(ay, by, qy) - offY0));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y - by0) * bw + x - bx0, px = meetX[i], py = meetY[i];
        // Barycentric weights of a (w0), b (w1) and c.
        const w0 = ((bx - px) * (qy - py) - (by - py) * (qx - px)) / area;
        const w1 = ((qx - px) * (ay - py) - (qy - py) * (ax - px)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const w2 = 1 - w0 - w1;
        if (am) {
          const u = uvs![ia * 2] * w0 + uvs![ib * 2] * w1 + uvs![ic * 2] * w2;
          const v = uvs![ia * 2 + 1] * w0 + uvs![ib * 2 + 1] * w1 + uvs![ic * 2 + 1] * w2;
          const tx = Math.min(am.width - 1, Math.floor((u - Math.floor(u)) * am.width));
          const ty = Math.min(am.height - 1, Math.floor((v - Math.floor(v)) * am.height));
          if (am.alpha[ty * am.width + tx] < ALPHA_CUTOFF) continue;
        }
        const z = over[ia] * w0 + over[ib] * w1 + over[ic] * w2 - ground[i];
        if (z < lowest[i]) lowest[i] = z;
      }
    }
  }
  // A surface less than a thousandth of a unit over the ground is on it (a box's bottom on flat ground: lit).
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const z = lowest[(y - by0) * bw + x - bx0];
      if (z > 1e-3 && z !== Infinity) out[y * w + x] = 0xff;
    }
  }
}

/** A cell's ground from the corners of its tile (their heights with the layers, without a ramp's lift), over the tile's
 *  two triangles. */
function cornerGround(t: Terrain, x: number, y: number): number {
  const tx = Math.min(x >> 2, t.width - 2), ty = Math.min(y >> 2, t.height - 2), u = ((x & 3) + 0.5) / 4, v = ((y & 3) + 0.5) / 4;
  const k = (i: number, j: number) => t.corners[(ty + j) * t.width + tx + i].height;
  return splitTile(k(0, 0), k(1, 0), k(0, 1), k(1, 1), u, v);
}

/** The new shadow map: cells whose prediction differs between the last
 *  saved state (`before`) and now (`after`) take the new prediction, all
 *  others keep the stored map. Without a stored map (or after a resize) the
 *  prediction is used as is. */
export function updateShadows(stored: Uint8Array | null, before: Uint8Array, after: Uint8Array): Uint8Array {
  if (!stored || stored.length !== after.length || before.length !== after.length) return after.slice();
  const out = stored.slice();
  for (let i = 0; i < out.length; i++) if (before[i] !== after[i]) out[i] = after[i];
  return out;
}
