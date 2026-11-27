// A light's direction as a sun angle. The lighting model stores a rotation (a quaternion) per key; the light shines
// from where its +Z axis points once turned by it (lib/model/dnclight lightAt). Shown and typed here as two angles:
// - direction: where the sun stands on the map, in the game's degrees (0 east, 90 north, 180 west, 270 south);
// - height: how far it is above the horizon (90 straight above, 0 at the horizon, below 0 from under the ground).
// A typed angle makes the shortest turn from straight above to that place: a directional light is the same from every
// turn about its own axis, so nothing else of the rotation shows. A key nobody types into keeps its quaternion.

const DEG = 180 / Math.PI;

export interface SunAngle { direction: number; height: number }

/** Where a rotation's light comes from. Straight above or below has no direction: 0. */
export function sunAngleOf(q: readonly number[]): SunAngle {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0) || !Number.isFinite(n)) return { direction: 0, height: 90 };
  const [x, y, z, w] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  // +Z turned by the rotation.
  const dx = 2 * (x * z + w * y), dy = 2 * (y * z - w * x), dz = 1 - 2 * (x * x + y * y);
  const height = Math.asin(Math.min(1, Math.max(-1, dz))) * DEG;
  const flat = Math.hypot(dx, dy);
  const direction = flat < 1e-6 ? 0 : ((Math.atan2(dy, dx) * DEG) % 360 + 360) % 360;
  return { direction: round(direction), height: round(height) };
}

/** The rotation (x, y, z, w) of a light that comes from `a`: the shortest turn of +Z to there. */
export function rotationOf(a: SunAngle): [number, number, number, number] {
  const d = a.direction / DEG, e = a.height / DEG;
  const dx = Math.cos(e) * Math.cos(d), dy = Math.cos(e) * Math.sin(d), dz = Math.sin(e);
  // Straight below: half a turn about X (any axis in the plane would do).
  if (dz < -1 + 1e-9) return [1, 0, 0, 0];
  // Axis +Z × dir = (-dy, dx, 0); w = 1 + +Z · dir; then to unit length.
  const w = 1 + dz;
  const n = Math.hypot(dy, dx, w);
  return [clean(-dy / n), clean(dx / n), 0, clean(w / n)];
}

/** Angles to four decimals: what the boxes show, steady over a quaternion stored as 32-bit floats. */
const round = (v: number) => { const r = Math.round(v * 1e4) / 1e4; return r === 0 || r === 360 ? 0 : r; };
/** Six significant digits, as the model's text holds its numbers; no negative zero. */
const clean = (v: number) => { const r = Number(v.toPrecision(6)); return Math.abs(r) < 1e-9 ? 0 : r; };
