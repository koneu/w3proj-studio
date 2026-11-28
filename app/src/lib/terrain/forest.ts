// The World Editor's multiple placement ("forest brush"): a palette brush of size 2 and up
// places one object on every point of a fixed pattern. Measured on trees, whose footprint is
// 128: rows lie one footprint apart. Square: a grid reaching (size-1) footprints from the
// centre. Circle: every second row is shifted by half a footprint, and a point is taken
// within a fixed radius per size. The centre snaps to a 64 grid. While the brush is
// dragged, a point where an object would overlap one already there stays empty.
//
// A type with a pathing texture is spaced by it (a barrel's 64, a barn's 320: its longer side), on the same grid. A
// doodad without one (flowers, bones, corn) has nothing to collide with: the editor spaces the same pattern by the
// model's own width (the longer of its X and Y extent, variation 0's model: Cattail 102.12, Rib Bones 335.82), centres
// it on the pointer itself, and places it again wherever the brush is pressed or dragged to, on top of what is there
// (a second click on one spot gives every point twice). Measured 2026-11-28, docs/testing/saved-data-rules.md.

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

/** How a packed brush lays out a type. `cells`: its pathing footprint (null: none); `span`: the width of its model on
 *  the ground (the longer of the X and Y extent; null: not known), which counts for a doodad or destructable without
 *  a footprint. `free`: nothing to collide with, so the centre is the pointer itself and every press or move of the
 *  brush places the whole pattern again, also on top of what is there (the World Editor on pathless doodads). */
export function forestLayout(cells: { width: number; height: number } | null, span: number | null): { spacing: number; free: boolean } {
  if (cells || span === null || !(span > 0) || !Number.isFinite(span)) return { spacing: forestSpacing(cells), free: false };
  return { spacing: span, free: true };
}

/** Whether two objects of footprint `spacing` at these places would overlap. */
export const forestOverlaps = (a: { x: number; y: number }, b: { x: number; y: number }, spacing: number) =>
  Math.abs(a.x - b.x) < spacing && Math.abs(a.y - b.y) < spacing;
