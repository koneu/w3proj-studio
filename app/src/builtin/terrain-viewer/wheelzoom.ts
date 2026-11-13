/** How much one notch of the mouse wheel changes the camera distance (the World Editor's step). */
export const WHEEL_ZOOM = 1.1;

/** The camera distance after one wheel notch: `out` zooms out (distance times the step), otherwise in (divided), kept within [min, max]. */
export function wheelZoomDistance(distance: number, out: boolean, min: number, max: number): number {
  return Math.max(min, Math.min(max, distance * (out ? WHEEL_ZOOM : 1 / WHEEL_ZOOM)));
}
