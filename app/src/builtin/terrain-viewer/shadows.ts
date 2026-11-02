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
import type { Terrain } from "./w3e";

/** Direction toward the sun: azimuth (degrees, counter-clockwise from +x)
 *  and elevation above the horizon. */
export interface Sun { azimuth: number; elevation: number }

/** Fitted against the sample maps. */
export const DEFAULT_SUN: Sun = { azimuth: 225, elevation: 30 };

function sunVector(s: Sun): [number, number, number] {
  const az = (s.azimuth * Math.PI) / 180, el = (s.elevation * Math.PI) / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

/** Ground height (bilinear over the corners), clamped to the map. */
function groundAt(t: Terrain, wx: number, wy: number): number {
  const fx = Math.min(Math.max((wx - t.offsetX) / 128, 0), t.width - 1.001);
  const fy = Math.min(Math.max((wy - t.offsetY) / 128, 0), t.height - 1.001);
  const x = Math.floor(fx), y = Math.floor(fy), u = fx - x, v = fy - y;
  const c = (i: number, j: number) => t.corners[(y + j) * t.width + x + i].height;
  return (c(0, 0) * (1 - u) + c(1, 0) * u) * (1 - v) + (c(0, 1) * (1 - u) + c(1, 1) * u) * v;
}

/** Terrain shadows: a cell is dark when the ray from its centre toward the
 *  sun passes under the ground. */
export function terrainShadows(t: Terrain, s: Sun = DEFAULT_SUN): Uint8Array {
  const sun = sunVector(s);
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const out = new Uint8Array(w * h);
  const len = Math.hypot(sun[0], sun[1]), dx = sun[0] / len, dy = sun[1] / len, rise = sun[2] / len;
  const maxX = t.offsetX + (t.width - 1) * 128, maxY = t.offsetY + (t.height - 1) * 128;
  let top = -Infinity;
  for (const c of t.corners) top = Math.max(top, c.height);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const wx = t.offsetX + cx * 32 + 16, wy = t.offsetY + cy * 32 + 16;
      const h0 = groundAt(t, wx, wy);
      for (let d = 16; ; d += 16) {
        const z = h0 + 1 + rise * d, px = wx + dx * d, py = wy + dy * d;
        if (z > top || px < t.offsetX || py < t.offsetY || px >= maxX || py >= maxY) break;
        if (groundAt(t, px, py) > z) { out[cy * w + cx] = 0xff; break; }
      }
    }
  }
  return out;
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

/** Darkens the cells under a model's shadow (projected along the sun onto
 *  the ground; cells whose centre is covered). */
export function castShadow(out: Uint8Array, t: Terrain, c: ShadowCaster, s: Sun = DEFAULT_SUN) {
  const sun = sunVector(s);
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4;
  const { positions: pos, faces } = c.mesh;
  const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
  const proj = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    const lx = pos[i * 3] * c.scale[0], ly = pos[i * 3 + 1] * c.scale[1], lz = pos[i * 3 + 2] * c.scale[2];
    const wx = c.x + lx * ca - ly * sa, wy = c.y + lx * sa + ly * ca, wz = c.z + lz;
    const k = Math.max(0, (wz - groundAt(t, wx, wy)) / sun[2]);
    proj[i * 2] = (wx - sun[0] * k - t.offsetX) / 32;
    proj[i * 2 + 1] = (wy - sun[1] * k - t.offsetY) / 32;
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
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, qx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, qx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, qy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, qy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        // Barycentric weights of a (w0), b (w1) and c.
        const w0 = ((bx - px) * (qy - py) - (by - py) * (qx - px)) / area;
        const w1 = ((qx - px) * (ay - py) - (qy - py) * (ax - px)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        if (am) {
          const w2 = 1 - w0 - w1;
          const u = uvs![ia * 2] * w0 + uvs![ib * 2] * w1 + uvs![ic * 2] * w2;
          const v = uvs![ia * 2 + 1] * w0 + uvs![ib * 2 + 1] * w1 + uvs![ic * 2 + 1] * w2;
          const tx = Math.min(am.width - 1, Math.floor((u - Math.floor(u)) * am.width));
          const ty = Math.min(am.height - 1, Math.floor((v - Math.floor(v)) * am.height));
          if (am.alpha[ty * am.width + tx] < ALPHA_CUTOFF) continue;
        }
        out[y * w + x] = 0xff;
      }
    }
  }
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
