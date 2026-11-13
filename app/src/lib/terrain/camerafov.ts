/**
 * A camera object's field of view is horizontal: the game and the World Editor keep it as the view gets wider or
 * narrower (we-drive, 2026-11-13: the same camera in a 1184x844 and a 1184x592 view shows the ground at nearly the
 * same width, not at the same height), while Studio's view camera takes a vertical one. These convert at the view's
 * width / height; aspect 4/3 is the old fixed preview.
 */

/** The vertical field of view (radians) of a view `aspect` wide for a horizontal one. */
export function verticalFov(horizontal: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(horizontal / 2) / safe(aspect));
}

/** The horizontal field of view (radians) of a view `aspect` wide for a vertical one. */
export function horizontalFov(vertical: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(vertical / 2) * safe(aspect));
}

/** A view with no size (or a bad one) counts as 4:3. */
const safe = (aspect: number) => (Number.isFinite(aspect) && aspect > 0.1 ? aspect : 4 / 3);
