import type { Vec3 } from "../../lib/model/renderer";

/**
 * How much one notch of the mouse wheel, or one press of Ctrl+Up or Ctrl+Down, changes the camera distance (the World
 * Editor's step). The keys are the wheel's zoom exactly (we-drive, branch key-zoom, cliff.w3m: Ctrl+Up then a notch
 * out, and a notch in then Ctrl+Down, give back the same picture to the pixel).
 */
export const WHEEL_ZOOM = 1.1;

/**
 * Where on the view the World Editor zooms about (wheel and keys alike): the middle column, at this row. It keeps its
 * camera target fixed and slides the eye along the ray to it, wherever the pointer is; it draws that target above the
 * middle (an off-centre projection). The row isn't a fixed share of the height: we-drive (branch key-zoom, cliff.w3m,
 * the focus of expansion of single notches and key presses) found it at 325.0 of a 844 high view, 222.6 of 592, 220.2
 * of 585 and 211.7 of 565, whatever the width (1184, 1184, 1036, 784); this line fits all four within 0.3 px, where
 * 325.5 / 844 of the height misses the smaller ones by 6. (As if the editor's 3D area began 29 px higher, under its
 * toolbar, with the target at 0.406 of that height.)
 */
export const ZOOM_PIVOT = Object.freeze({ perHeight: 0.4057, offset: -17.4 });

/** The row (pixels from the top) of a view `height` pixels high that the zoom keeps in place (ZOOM_PIVOT), within the view. */
export function zoomPivotRow(height: number): number {
  return Math.max(0, Math.min(height, ZOOM_PIVOT.perHeight * height + ZOOM_PIVOT.offset));
}

/** The camera distance after one wheel notch: `out` zooms out (distance times the step), otherwise in (divided), kept within [min, max]. */
export function wheelZoomDistance(distance: number, out: boolean, min: number, max: number): number {
  return Math.max(min, Math.min(max, distance * (out ? WHEEL_ZOOM : 1 / WHEEL_ZOOM)));
}

/**
 * The point the zoom keeps in place: where the ray through the view's zoomPivotRow meets the level of the camera
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

/** What zoomStep needs of the view: its size in CSS pixels, its camera, and the ray through a point of it. */
export interface ZoomView {
  width: number;
  height: number;
  target: Vec3;
  distance: number;
  ray(x: number, y: number): { origin: Vec3; dir: Vec3 };
}

/**
 * One step of the World Editor's zoom, a wheel notch or a press of Ctrl+Up or Ctrl+Down: the camera's new target and
 * distance (`out` zooms out), about the point at the middle column's zoomPivotRow, the distance kept within [min, max].
 */
export function zoomStep(view: ZoomView, out: boolean, min: number, max: number): { target: Vec3; distance: number } {
  const next = wheelZoomDistance(view.distance, out, min, max);
  const pivot = wheelPivot(view.ray(view.width / 2, zoomPivotRow(view.height)), view.target, view.distance * 20);
  return { target: wheelZoomTarget(view.target, pivot, view.distance, next), distance: next };
}
