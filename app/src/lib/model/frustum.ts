// What the camera sees: the six planes of a view-projection matrix, and whether a bounding sphere
// is inside them. Objects outside the view aren't drawn.

/** The planes (a, b, c, d; normal pointing inwards, unit length) of a column-major view-projection
 *  matrix: left, right, bottom, top, near, far. A point p is inside when a·x + b·y + c·z + d >= 0 for each. */
export function frustumPlanes(m: Float32Array, out = new Float32Array(24)): Float32Array {
  // Row i of the matrix is (m[i], m[4 + i], m[8 + i], m[12 + i]); clip w is row 3.
  for (let p = 0; p < 6; p++) {
    const row = p >> 1, sign = p & 1 ? -1 : 1;
    const a = m[3] + sign * m[row], b = m[7] + sign * m[4 + row], c = m[11] + sign * m[8 + row], d = m[15] + sign * m[12 + row];
    const l = Math.hypot(a, b, c) || 1;
    out[p * 4] = a / l; out[p * 4 + 1] = b / l; out[p * 4 + 2] = c / l; out[p * 4 + 3] = d / l;
  }
  return out;
}

/** A model's bounding sphere comes from its standing pose: what it does while it animates (a tree
 *  swaying, an arm raised) can reach past it. It counts as this much bigger, so nothing is left out
 *  at the edge of the view. */
const SPHERE_SCALE = 1.5, SPHERE_MARGIN = 64;

/** Whether any of a sphere [x, y, z, r] (with the margin above) is inside the planes. */
export function sphereInView(planes: Float32Array, s: readonly number[]): boolean {
  const r = s[3] * SPHERE_SCALE + SPHERE_MARGIN;
  for (let p = 0; p < 24; p += 4) {
    if (planes[p] * s[0] + planes[p + 1] * s[1] + planes[p + 2] * s[2] + planes[p + 3] < -r) return false;
  }
  return true;
}
