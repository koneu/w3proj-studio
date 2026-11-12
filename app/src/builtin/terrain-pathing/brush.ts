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

/**
 * The outline the brush draws for a stamp on cell (cx, cy): centred on that cell, reaching to the far edge of the
 * outermost cells brushCells paints (a square of 2 * radius - 1 cells across), in world units.
 */
export function brushOutline(cx: number, cy: number, radius: number, offsetX: number, offsetY: number): { x: number; y: number; r: number } {
  return { x: offsetX + (cx + 0.5) * 32, y: offsetY + (cy + 0.5) * 32, r: (radius - 0.5) * 32 };
}
