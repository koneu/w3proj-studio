// Camera objects (war3map.w3c) drawn: the Camera Editor's overlay on the ground (the target, the eye, the line
// between them and the field of view, one texel per pathing cell of 32 units: cameraColors), and the terrain
// viewer's Camera Objects layer as the World Editor draws it, one small camera model with an arrow to its target
// per camera (cameraMarkers).

/** The values of a camera object the drawing needs (the w3c entry has more). */
export interface CameraObject { name?: string; targetX: number; targetY: number; zOffset?: number; rotation: number; distance: number; angleOfAttack: number; fieldOfView: number }

/** The colours (RGBA) of one camera's parts, and the size of its two dots (radius in cells). */
export interface CameraLook { fov: number[]; line: number[]; target: number[]; eye: number[]; targetRadius: number; eyeRadius: number }

/** cameraColors' default colours. */
export const LAYER_LOOK: CameraLook = { fov: [255, 150, 60, 130], line: [255, 190, 60, 230], target: [255, 190, 60, 255], eye: [255, 255, 255, 255], targetRadius: 2, eyeRadius: 1 };

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
/** Cell size of the drawing (world units): the pathing cells. */
export const CAMERA_CELL = 32;

/** Where a camera object's eye is over the ground (x, y): `distance` back from the target along its rotation. */
export const cameraEye = (c: CameraObject): [number, number] => {
  const d = c.distance * Math.abs(Math.cos(c.angleOfAttack * RAD));
  return [c.targetX - d * Math.cos(c.rotation * RAD), c.targetY - d * Math.sin(c.rotation * RAD)];
};

/**
 * The camera objects drawn on the ground, rows from the south, `width` × `height` cells from
 * (offsetX, offsetY). A camera with a value that isn't a number is left out whole. `lookOf` gives
 * each camera its colours (the Camera Editor shows the selected one apart); later cameras are
 * drawn over earlier ones.
 */
export function cameraColors(cameras: readonly CameraObject[], width: number, height: number, offsetX: number, offsetY: number,
  lookOf: (c: CameraObject) => CameraLook = () => LAYER_LOOK): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const dot = (x: number, y: number, r: number, c: number[]) => {
    const cx = Math.floor((x - offsetX) / CAMERA_CELL), cy = Math.floor((y - offsetY) / CAMERA_CELL);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const px = cx + i, py = cy + j;
      if (i * i + j * j <= r * r + r && px >= 0 && py >= 0 && px < width && py < height) rgba.set(c, (py * width + px) * 4);
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
    const n = Math.min(4096, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CAMERA_CELL / 2)));
    for (let k = 0; k <= n; k++) dot(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 0, c);
  };
  for (const c of cameras) {
    if (![c.targetX, c.targetY, c.rotation, c.distance, c.angleOfAttack, c.fieldOfView].every(Number.isFinite)) continue;
    const look = lookOf(c);
    const [ex, ey] = cameraEye(c);
    // Field of view: two edges from the eye, as long as the eye-to-target line.
    const len = Math.hypot(c.targetX - ex, c.targetY - ey);
    const half = Math.min(80, Math.max(1, c.fieldOfView / 2)) * RAD;
    for (const s of [-1, 1]) {
      const a = c.rotation * RAD + s * half;
      line(ex, ey, ex + (len / Math.cos(half)) * Math.cos(a), ey + (len / Math.cos(half)) * Math.sin(a), look.fov);
    }
    line(ex, ey, c.targetX, c.targetY, look.line);
    dot(c.targetX, c.targetY, look.targetRadius, look.target);
    dot(ex, ey, look.eyeRadius, look.eye);
  }
  return rgba;
}

/** The Camera Objects layer's colour (RGB, the faces lit 0.72 to 1 of it): the World Editor's blue, measured under
 *  12b_RoC_Orc04Interlude's lighting (faces from 50,71,171 to 71,99,233). */
export const MARKER_RGB: readonly [number, number, number] = [72, 100, 235];

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
/** The light the marker's faces are shaded by (a fixed one: the layer is an editor mark, not lit by the map). */
const MARKER_LIGHT = (() => { const l = [0.35, 0.45, 0.82], n = Math.hypot(...l); return l.map((v) => v / n); })();

/**
 * The Camera Objects layer: a marker per camera (MARKER) as triangles, 7 floats per corner (x, y, z, r, g, b, a in
 * 0..1), every face shaded by its slant to a fixed light. The target stands `zOffset` over the ground (`groundZ`), as
 * the game puts it. A camera with a value that isn't a number, or no distance, is left out.
 */
export function cameraMarkers(cameras: readonly CameraObject[], groundZ: (x: number, y: number) => number,
  rgb: readonly number[] = MARKER_RGB): number[] {
  const out: number[] = [];
  for (const c of cameras) {
    const zOff = c.zOffset ?? 0;
    if (![c.targetX, c.targetY, zOff, c.rotation, c.distance, c.angleOfAttack].every(Number.isFinite) || c.distance <= 0) continue;
    const tz = groundZ(c.targetX, c.targetY) + zOff;
    if (!Number.isFinite(tz)) continue;
    const r = c.rotation * RAD, a = c.angleOfAttack * RAD, d = c.distance;
    // Forward (from the eye to the target), right and up of the camera.
    const f = [Math.cos(a) * Math.cos(r), Math.cos(a) * Math.sin(r), Math.sin(a)];
    const s = [Math.sin(r), -Math.cos(r), 0];
    const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
    const at = (along: number, side: number, up: number): number[] =>
      [0, 1, 2].map((i) => [c.targetX, c.targetY, tz][i] + (-f[i] * along + s[i] * side + u[i] * up) * d);
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
        const lit = 0.72 + 0.28 * Math.max(0, n[0] * MARKER_LIGHT[0] + n[1] * MARKER_LIGHT[1] + n[2] * MARKER_LIGHT[2]);
        const col = [rgb[0] / 255 * lit, rgb[1] / 255 * lit, rgb[2] / 255 * lit, 1];
        for (let k = 1; k + 1 < face.length; k++) for (const v of [face[0], face[k], face[k + 1]]) out.push(v[0], v[1], v[2], ...col);
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
