// A click on a doodad or destructable picks it by its model, placed as the object is drawn, as the World Editor does
// (doodad-pick-we): clicks 45 to 80 units off a tree's, rock's or rune's centre on bare ground select the object where
// the model stands, and nothing where only its pathing footprint does; behind the base the model's height catches the
// click that the ground there misses.
import type { Geoset } from "../../lib/model/mdx";

type Vec3 = readonly [number, number, number];

/** The inverse of a column-major world matrix made of a rotation, a scale and a translation (objects.ts `placement`); null when it has no inverse. */
export function inverseAffine(m: ArrayLike<number>): Float64Array | null {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) + b * (f * g - d * i) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const r = 1 / det;
  const out = new Float64Array(12);
  out[0] = (e * i - f * h) * r; out[1] = (c * h - b * i) * r; out[2] = (b * f - c * e) * r;
  out[3] = (f * g - d * i) * r; out[4] = (a * i - c * g) * r; out[5] = (c * d - a * f) * r;
  out[6] = (d * h - e * g) * r; out[7] = (b * g - a * h) * r; out[8] = (a * e - b * d) * r;
  // Row-major 3x3 in out[0..8]; the translation after it.
  out[9] = -(out[0] * m[12] + out[1] * m[13] + out[2] * m[14]);
  out[10] = -(out[3] * m[12] + out[4] * m[13] + out[5] * m[14]);
  out[11] = -(out[6] * m[12] + out[7] * m[13] + out[8] * m[14]);
  return out;
}

/**
 * The distance (in the ray's own units: `dir` needn't be a unit vector) along the ray to the model's bounding box
 * (model space `min`, `max`) placed by `world`, or Infinity: a ray inside the box has t = 0 hit from its far side, so
 * the entry distance is returned only when above 0.
 */
export function rayBox(box: { min: readonly number[]; max: readonly number[] }, world: ArrayLike<number>, origin: Vec3, dir: Vec3): number {
  const inv = inverseAffine(world);
  if (!inv) return Infinity;
  const o = [0, 1, 2].map((r) => inv[r * 3]! * origin[0] + inv[r * 3 + 1]! * origin[1] + inv[r * 3 + 2]! * origin[2] + inv[9 + r]!);
  const d = [0, 1, 2].map((r) => inv[r * 3]! * dir[0] + inv[r * 3 + 1]! * dir[1] + inv[r * 3 + 2]! * dir[2]);
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const lo = box.min[k]!, hi = box.max[k]!;
    if (Math.abs(d[k]!) < 1e-12) { if (o[k]! < lo || o[k]! > hi) return Infinity; continue; }
    let a = (lo - o[k]!) / d[k]!, b = (hi - o[k]!) / d[k]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  return t0 > 0 ? t0 : t1 > 0 ? t1 : Infinity;
}

/**
 * The distance along the ray to the nearest triangle of the model's full-detail geosets placed by `world` (standing
 * pose, either side of a triangle), or Infinity.
 */
export function rayMesh(geosets: readonly Pick<Geoset, "positions" | "faces" | "lod">[], world: ArrayLike<number>, origin: Vec3, dir: Vec3): number {
  const inv = inverseAffine(world);
  if (!inv) return Infinity;
  const px = inv[0] * origin[0] + inv[1] * origin[1] + inv[2] * origin[2] + inv[9], py = inv[3] * origin[0] + inv[4] * origin[1] + inv[5] * origin[2] + inv[10], pz = inv[6] * origin[0] + inv[7] * origin[1] + inv[8] * origin[2] + inv[11];
  const dx = inv[0] * dir[0] + inv[1] * dir[1] + inv[2] * dir[2], dy = inv[3] * dir[0] + inv[4] * dir[1] + inv[5] * dir[2], dz = inv[6] * dir[0] + inv[7] * dir[1] + inv[8] * dir[2];
  let best = Infinity;
  for (const g of geosets) {
    if (g.lod !== 0) continue;
    const v = g.positions, f = g.faces;
    for (let k = 0; k + 2 < f.length; k += 3) {
      const i0 = f[k]! * 3, i1 = f[k + 1]! * 3, i2 = f[k + 2]! * 3;
      if (i0 + 2 >= v.length || i1 + 2 >= v.length || i2 + 2 >= v.length) continue;
      const e1x = v[i1]! - v[i0]!, e1y = v[i1 + 1]! - v[i0 + 1]!, e1z = v[i1 + 2]! - v[i0 + 2]!;
      const e2x = v[i2]! - v[i0]!, e2y = v[i2 + 1]! - v[i0 + 1]!, e2z = v[i2 + 2]! - v[i0 + 2]!;
      const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(det) < 1e-12) continue;
      const r = 1 / det;
      const sx = px - v[i0]!, sy = py - v[i0 + 1]!, sz = pz - v[i0 + 2]!;
      const u = (sx * hx + sy * hy + sz * hz) * r;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const w = (dx * qx + dy * qy + dz * qz) * r;
      if (w < 0 || u + w > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * r;
      if (t > 0 && t < best) best = t;
    }
  }
  return best;
}
