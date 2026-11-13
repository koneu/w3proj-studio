import type { Vec3 } from "../../lib/model/renderer";

/** How much one notch of the mouse wheel changes the camera distance (the World Editor's step). */
export const WHEEL_ZOOM = 1.1;

/**
 * Where on the view the wheel zooms about: the middle column, this far down. The World Editor keeps its camera target
 * fixed and slides the eye along the ray to it, wherever the pointer is; it draws that target above the middle (an
 * off-centre projection), at row 325.5 of its 1184 × 844 view (we-drive, cliff.w3m, the focus of expansion of three
 * notches at the view's middle, its top left and its bottom right: the same point each time).
 */
export const WHEEL_PIVOT_ROW = 325.5 / 844;

/** The camera distance after one wheel notch: `out` zooms out (distance times the step), otherwise in (divided), kept within [min, max]. */
export function wheelZoomDistance(distance: number, out: boolean, min: number, max: number): number {
  return Math.max(min, Math.min(max, distance * (out ? WHEEL_ZOOM : 1 / WHEEL_ZOOM)));
}

/**
 * The point the wheel zooms about: where the ray through the view's WHEEL_PIVOT_ROW meets the level of the camera
 * target. The target itself (the middle of the view) when the ray meets that level behind the eye, not at all, or
 * farther than `reach` (a camera looking nearly level).
 */
export function wheelPivot(ray: { origin: Vec3; dir: Vec3 }, target: Vec3, reach: number): Vec3 {
  const { origin: o, dir: d } = ray;
  if (!(d[2] < -1e-6)) return [...target];
  const t = (target[2] - o[2]) / d[2];
  if (!(t > 0 && t <= reach)) return [...target];
  return [o[0] + d[0] * t, o[1] + d[1] * t, target[2]];
}

/**
 * The camera target after the distance went from `distance` to `next`, zooming about `pivot`: target and eye scale
 * about it by the same ratio, so the eye slides along the ray through the pivot, which stays where it is on the view,
 * and the camera keeps its angles.
 */
export function wheelZoomTarget(target: Vec3, pivot: Vec3, distance: number, next: number): Vec3 {
  const k = distance > 0 ? next / distance : 1;
  return [pivot[0] + (target[0] - pivot[0]) * k, pivot[1] + (target[1] - pivot[1]) * k, pivot[2] + (target[2] - pivot[2]) * k];
}
