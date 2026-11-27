// The World Editor's multiple placement ("forest brush"): a palette brush of size 2 and up
// places one object on every point of a fixed pattern. Measured on trees, whose footprint is
// 128: rows lie one footprint apart. Square: a grid reaching (size-1) footprints from the
// centre. Circle: every second row is shifted by half a footprint, and a point is taken
// within a fixed radius per size. The centre snaps to a 64 grid. While the brush is
// dragged, a point where an object would overlap one already there stays empty.

export const FOREST_SIZES = [1, 2, 3, 5, 8] as const;
export type ForestShape = "circle" | "square";

/** The circle's radius per size, for a 128 footprint: any radius in the measured range gives
 *  the same points (size 2: 143–255, 3: 256–286, 5: 528–571, 8: 969–999). */
const CIRCLE_RADIUS: Record<number, number> = { 1: 0, 2: 160, 3: 272, 5: 544, 8: 980 };

/** The distance between neighbours for a pathing footprint of `cells` (32 units each; none: a tree's 128). */
export function forestSpacing(cells: { width: number; height: number } | null): number {
  return cells ? Math.max(64, Math.ceil((Math.max(cells.width, cells.height) * 32) / 64) * 64) : 128;
}

/** Where the brush's centre lands for a pointer position. */
export const forestCentre = (x: number, y: number): [number, number] => [Math.round(x / 64) * 64, Math.round(y / 64) * 64];

/** The pattern's points relative to the centre, north row first and west to east (the editor's order). */
export function forestPoints(size: number, shape: ForestShape, spacing = 128): [number, number][] {
  const out: [number, number][] = [];
  const reach = shape === "square" ? size - 1 : Math.ceil(CIRCLE_RADIUS[size] / 128);
  const unit = spacing / 128;
  for (let row = reach; row >= -reach; row--) {
    const shift = shape === "circle" && Math.abs(row) % 2 === 1 ? 64 : 0;
    for (let i = -reach - 1; i <= reach; i++) {
      const x = i * 128 + shift, y = row * 128;
      if (shape === "square") {
        if (Math.abs(i) > reach) continue;
      } else if (Math.hypot(x, y) > CIRCLE_RADIUS[size] || x >= (size - 0.5) * 128 && size > 1) {
        // The brush's east edge is open: at size 8 the editor leaves out (960, ±128) and keeps (-960, ±128).
        continue;
      }
      out.push([x * unit, y * unit]);
    }
  }
  return out;
}

/** How far the brush reaches from its centre (for the ring under the pointer). */
export const forestReach = (size: number, spacing = 128) => (size - 1) * spacing + spacing / 2;

/** Whether two objects of footprint `spacing` at these places would overlap. */
export const forestOverlaps = (a: { x: number; y: number }, b: { x: number; y: number }, spacing: number) =>
  Math.abs(a.x - b.x) < spacing && Math.abs(a.y - b.y) < spacing;
