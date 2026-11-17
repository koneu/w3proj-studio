// A closed line in the world as the pixels of a one-pixel-wide, unsmoothed line: what the World Editor draws its
// camera bounds with (one pixel of exactly one colour; the canvas smooths a GL line over two pixels at half strength).

/** The pixels (x, y pairs, y down from the top) of the closed line through `points` (x, y, z triples) seen through
 *  `viewProj` (column-major, as the renderer builds it) in a picture of W x H pixels: each segment cut to the front of
 *  the camera and to the picture, then stepped pixel by pixel (Bresenham), so the line is one pixel wide. A pixel that
 *  ends one segment and begins the next is listed twice. */
export function crispPixels(points: ArrayLike<number>, viewProj: ArrayLike<number>, W: number, H: number): number[] {
  const n = Math.floor(points.length / 3), out: number[] = [];
  const clip = (i: number) => {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    return [0, 1, 2, 3].map((r) => viewProj[r] * x + viewProj[4 + r] * y + viewProj[8 + r] * z + viewProj[12 + r]);
  };
  const near = 1e-4;
  for (let i = 0; i < n && n > 1; i++) {
    let a = clip(i), b = clip((i + 1) % n);
    // Keep what is in front of the camera.
    if (a[3] < near && b[3] < near) continue;
    if (a[3] < near) { const t = (near - a[3]) / (b[3] - a[3]); a = a.map((v, k) => v + (b[k] - v) * t); }
    else if (b[3] < near) { const t = (near - b[3]) / (a[3] - b[3]); b = b.map((v, k) => v + (a[k] - v) * t); }
    let x0 = (a[0] / a[3] + 1) / 2 * W, y0 = (1 - a[1] / a[3]) / 2 * H, x1 = (b[0] / b[3] + 1) / 2 * W, y1 = (1 - b[1] / b[3]) / 2 * H;
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    // Liang-Barsky to the picture, so a segment far outside costs nothing.
    let t0 = 0, t1 = 1, inside = true;
    const dx = x1 - x0, dy = y1 - y0;
    for (const [p, q] of [[-dx, x0], [dx, W - 1e-3 - x0], [-dy, y0], [dy, H - 1e-3 - y0]]) {
      if (p === 0) { if (q < 0) inside = false; continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (!inside || t0 > t1) continue;
    [x0, y0, x1, y1] = [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1];
    let px = Math.floor(x0), py = Math.floor(y0);
    const ex = Math.floor(x1), ey = Math.floor(y1), sx = ex >= px ? 1 : -1, sy = ey >= py ? 1 : -1;
    const ax = Math.abs(ex - px), ay = Math.abs(ey - py);
    let err = ax - ay;
    for (;;) {
      out.push(px, py);
      if (px === ex && py === ey) break;
      const e2 = 2 * err;
      if (e2 > -ay) { err -= ay; px += sx; }
      if (e2 < ax) { err += ax; py += sy; }
    }
  }
  return out;
}
