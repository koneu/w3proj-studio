// Which pathing cells a brush stamp covers.

/**
 * Cell indices (y * width + x) under a brush centred on cell (cx, cy), clipped to the width × height map.
 * Round: the cells within radius - 0.5 of the centre. Square: every cell with |dx|, |dy| < radius.
 */
export function brushCells(cx: number, cy: number, radius: number, square: boolean, width: number, height: number): number[] {
  const out: number[] = [];
  for (let y = cy - radius + 1; y < cy + radius; y++) {
    for (let x = cx - radius + 1; x < cx + radius; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (!square && Math.hypot(x - cx, y - cy) > radius - 0.5) continue;
      out.push(y * width + x);
    }
  }
  return out;
}
