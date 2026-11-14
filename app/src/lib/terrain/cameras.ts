// Camera objects (war3map.w3c) drawn as the World Editor draws them, in the terrain viewer's Camera Objects layer
// and on the Cameras tab: one small camera model with an arrow to its target per camera (cameraMarkers), and where
// a click takes one (markerHandles).

/** The values of a camera object the drawing needs (the w3c entry has more). */
export interface CameraObject { name?: string; targetX: number; targetY: number; zOffset?: number; rotation: number; distance: number; angleOfAttack: number; fieldOfView: number }

/** Version 3's floats after the local angles: the World Editor's DoF Distance, DoF Scale and Pos Absolute Z, in the
 *  file's order (the codec's cameras definition). JSON written before they had names keeps them in `unknown`. */
export const DEPTH_OF_FIELD = ["dofDistance", "dofScale", "posAbsoluteZ"] as const;
type DepthOfField = { [K in (typeof DEPTH_OF_FIELD)[number]]?: number } & { unknown?: number[] };

/** Gives a camera of older JSON its named fields (from `unknown`, which goes); a named field already there wins, as the
 *  codec reads it. `fill`: the missing ones become 0, as a version 3 file needs them. */
export function nameDepthOfField(c: DepthOfField, fill = false): void {
  DEPTH_OF_FIELD.forEach((k, i) => {
    const old = c.unknown?.[i];
    if (c[k] === undefined && (old !== undefined || fill)) c[k] = old ?? 0;
  });
  delete c.unknown;
}

const RAD = Math.PI / 180;

/** The camera marker's colour before light (RGB; the renderer lights it with the map's light, setShapes): fitted on
 *  the World Editor's HD pictures (we-drive, 2026-11-13) of 12b_RoC_Orc04Interlude's 28 cameras (mean 49,67,151 at
 *  its opening view) and of cameras on cliff.w3m (136,242,254), together. */
export const MARKER_RGB: readonly [number, number, number] = [66, 112, 228];

/**
 * The World Editor's camera marker, measured with we-drive (2026-11-13, cameras of distance 500, 1000 and 2000 on a
 * flat map; pictures in target/evidence/camera-layer of the main checkout): a small movie camera (a box, two reels on
 * top, a lens in front) and an arrow from it to the target, one model pointing along the camera's view and scaled by
 * its distance, so it is world-sized (it grows as the view comes closer) and a camera farther away draws bigger. The
 * arrow's tip is the target; the camera's back lies 0.365 of the distance from it (the camera's eye is farther out).
 * Sizes below are fractions of the distance, `along` measured back from the target.
 */
const MARKER = {
  head: { tip: 0, base: 0.035, half: 0.008 },
  shaft: { from: 0.035, to: 0.29, half: 0.0022 },
  lens: { front: 0.28, back: 0.295, frontHalf: 0.009, backHalf: 0.006, up: -0.0025 },
  body: { front: 0.295, back: 0.365, half: 0.013, low: -0.009, high: 0.004 },
  reels: { at: [0.313, 0.347], up: 0.0125, radius: 0.0085, half: 0.009 },
};
/**
 * A camera's marker frame: the world point `along` (back from the target toward the eye), `side` (to the camera's
 * right) and `up` (the camera's up) away from its target, all as fractions of its distance. The target stands
 * `zOffset` over the ground (`groundZ`). Null for a camera with a value that isn't a number, or no distance.
 */
function markerFrame(c: CameraObject, groundZ: (x: number, y: number) => number): ((along: number, side: number, up: number) => number[]) | null {
  const zOff = c.zOffset ?? 0;
  if (![c.targetX, c.targetY, zOff, c.rotation, c.distance, c.angleOfAttack].every(Number.isFinite) || c.distance <= 0) return null;
  const tz = groundZ(c.targetX, c.targetY) + zOff;
  if (!Number.isFinite(tz)) return null;
  const r = c.rotation * RAD, a = c.angleOfAttack * RAD, d = c.distance;
  // Forward (from the eye to the target), right and up of the camera.
  const f = [Math.cos(a) * Math.cos(r), Math.cos(a) * Math.sin(r), Math.sin(a)];
  const s = [Math.sin(r), -Math.cos(r), 0];
  const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
  const o = [c.targetX, c.targetY, tz];
  return (along, side, up) => [0, 1, 2].map((i) => o[i] + (-f[i] * along + s[i] * side + u[i] * up) * d);
}

/** Where a camera's marker (cameraMarkers) can be taken: its target (the arrow's tip) and its camera's box, front and
 *  back (world points), and how wide the box is (world units). Null where no marker is drawn. */
export function markerHandles(c: CameraObject, groundZ: (x: number, y: number) => number): { target: number[]; front: number[]; back: number[]; width: number } | null {
  const at = markerFrame(c, groundZ);
  if (!at) return null;
  return { target: at(0, 0, 0), front: at(MARKER.lens.front, 0, 0), back: at(MARKER.body.back, 0, 0), width: 2 * MARKER.body.half * c.distance };
}

/** How far a point (x, y) is from the segment a–b (points on the view, pixels). */
export function segmentDistance(x: number, y: number, a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** Floats per corner of cameraMarkers' triangles: x, y, z, the face's normal, r, g, b, a. */
export const MARKER_STRIDE = 10;

/**
 * The Camera Objects layer: a marker per camera (MARKER) as triangles, MARKER_STRIDE floats per corner (x, y, z, the
 * face's outward normal, then r, g, b, a in 0..1: the colour before light, which the renderer adds as on a placed
 * model). The target stands `zOffset` over the ground (`groundZ`), as the game puts it. A camera with a value that
 * isn't a number, or no distance, is left out.
 */
export function cameraMarkers(cameras: readonly CameraObject[], groundZ: (x: number, y: number) => number,
  rgb: readonly number[] = MARKER_RGB): number[] {
  const out: number[] = [];
  const col = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1];
  for (const c of cameras) {
    const at = markerFrame(c, groundZ);
    if (!at) continue;
    /** A closed part from its faces (corner lists, 3 or 4 each), each shaded by its normal turned away from the part's middle. */
    const part = (faces: number[][][]) => {
      const all = faces.flat(), mid = [0, 1, 2].map((i) => all.reduce((sum, p) => sum + p[i], 0) / all.length);
      for (const face of faces) {
        const [p, q, w] = face;
        const e1 = [0, 1, 2].map((i) => q[i] - p[i]), e2 = [0, 1, 2].map((i) => w[i] - p[i]);
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        n = n.map((v) => v / len);
        const centre = [0, 1, 2].map((i) => face.reduce((sum, v) => sum + v[i], 0) / face.length);
        if (n.reduce((sum, v, i) => sum + v * (centre[i] - mid[i]), 0) < 0) n = n.map((v) => -v);
        for (let k = 1; k + 1 < face.length; k++) for (const v of [face[0], face[k], face[k + 1]]) out.push(v[0], v[1], v[2], n[0], n[1], n[2], ...col);
      }
    };
    /** A box or frustum along the view: rectangles at `a0` and `a1` (half side, low and high up each). */
    const frustum = (a0: number, s0: number, lo0: number, hi0: number, a1: number, s1: number, lo1: number, hi1: number) => {
      const ring0 = [at(a0, -s0, lo0), at(a0, s0, lo0), at(a0, s0, hi0), at(a0, -s0, hi0)];
      const ring1 = [at(a1, -s1, lo1), at(a1, s1, lo1), at(a1, s1, hi1), at(a1, -s1, hi1)];
      part([ring0, ring1, ...[0, 1, 2, 3].map((i) => [ring0[i], ring0[(i + 1) % 4], ring1[(i + 1) % 4], ring1[i]])]);
    };
    const { head, shaft, lens, body, reels } = MARKER;
    // The arrowhead: a pyramid with its tip on the target.
    const tip = at(head.tip, 0, 0);
    const base = [at(head.base, -head.half, -head.half), at(head.base, head.half, -head.half), at(head.base, head.half, head.half), at(head.base, -head.half, head.half)];
    part([base, ...[0, 1, 2, 3].map((i) => [tip, base[i], base[(i + 1) % 4]])]);
    frustum(shaft.from, shaft.half, -shaft.half, shaft.half, shaft.to, shaft.half, -shaft.half, shaft.half);
    frustum(lens.front, lens.frontHalf, lens.up - lens.frontHalf, lens.up + lens.frontHalf, lens.back, lens.backHalf, lens.up - lens.backHalf, lens.up + lens.backHalf);
    frustum(body.front, body.half, body.low, body.high, body.back, body.half, body.low, body.high);
    // The reels: eight-sided drums across the camera, on top of the box.
    for (const along of reels.at) {
      const rim = (side: number) => Array.from({ length: 8 }, (_, k) => {
        const t = (k / 8) * Math.PI * 2;
        return at(along + Math.cos(t) * reels.radius, side, reels.up + Math.sin(t) * reels.radius);
      });
      const left = rim(-reels.half), right = rim(reels.half);
      part([left, right, ...left.map((_, k) => [left[k], left[(k + 1) % 8], right[(k + 1) % 8], right[k]])]);
    }
  }
  return out;
}
