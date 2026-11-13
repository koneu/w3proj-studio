// Where the World Editor puts a doodad or destructable when it opens a map: on its own grid, worked out from its
// pathing texture. Measured with we-drive (2026-11-13, a copy of empty_map_on_newest_world_editor.w3m with 340
// doodads off their grids, opened and saved by the editor; doodadgrid.test.ts has the measured cases) and borne out
// by every doodad with a pathing texture on the 14 maps of smoketest_maps (44 390 of 44 390):
// - a type with a pathing texture stands on the building grid of its texture's size (placement.ts onBuildingGrid):
//   its texture's edges on the 64 grid, so a 2×2 or 6×6 one at 64n + 32, a 4×4 or 8×8 one at 64n, each axis on its
//   own, the nearest such point, halves upwards (-3328 goes to -3296 on the 64n + 32 grid, -3040 to -3008 on 64n);
// - the texture is drawn for the default facing 270°: at a quarter turn of 0° or 180° its width lies along y;
// - a type whose texture isn't square also turns to the nearest quarter turn (all 73 such on those maps are), a
//   square one keeps its angle;
// - a type without a pathing texture (none, _) stays where it is, angle too.
// The editor doesn't count this as a change (closing it asks nothing), but its next save writes the new places.

import { onBuildingGrid } from "./placement";
import type { Placed } from "./objects";

/** A pathing texture's size in cells. */
export interface PathSize { width: number; height: number }

const QUARTER = Math.fround(Math.PI / 2);

/** The quarter turn (0 to 3, counter-clockwise from east) the World Editor rounds an angle to. Worked out in single
 *  precision, as its own arithmetic: 45° goes to 90°, 135° to 180°, 225° to 270°, but 315° (stored a hair under) to
 *  270° and 315.1° to 0° (measured). */
export function quarterTurn(angle: number): number {
  const q = Math.floor(Math.fround(Math.fround(Math.fround(angle) / QUARTER) + 0.5));
  return ((q % 4) + 4) % 4;
}

/** Where the World Editor puts a doodad of pathing size `size` (null: no pathing texture) that is stored at (x, y)
 *  with `angle` (radians), and the angle it turns it to. */
export function doodadOnGrid(x: number, y: number, angle: number, size: PathSize | null): { x: number; y: number; angle: number } {
  if (!size || !(size.width >= 1) || !(size.height >= 1) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angle)) return { x, y, angle };
  const q = quarterTurn(angle);
  // The textures are drawn for 270°: turned by a quarter (0° or 180°), the width lies along y.
  const across = q % 2 === 0;
  const cellsX = across ? size.height : size.width, cellsY = across ? size.width : size.height;
  const quarter = Math.fround((q * Math.PI) / 2);
  // Compared as the file stores them (single precision): the JSON's 3.1415927 is the file's π, and stays as written.
  const keep = (was: number, now: number) => (Math.fround(was) === now ? was : now);
  const turned = size.width === size.height ? angle : keep(angle, quarter);
  return { x: keep(x, onBuildingGrid(x, cellsX)), y: keep(y, onBuildingGrid(y, cellsY)), angle: turned };
}

/** The doodads of a list the World Editor would move or turn when it opens the map, with where to. `sizeOf`: an
 *  id's pathing texture size, null for none. */
export function doodadSnaps(list: readonly Placed[], sizeOf: (id: string) => PathSize | null): { entry: Placed; x: number; y: number; angle: number }[] {
  const out: { entry: Placed; x: number; y: number; angle: number }[] = [];
  for (const entry of list) {
    const [x, y] = entry.position;
    const at = doodadOnGrid(x, y, entry.angle, sizeOf(entry.id));
    if (at.x !== x || at.y !== y || at.angle !== entry.angle) out.push({ entry, ...at });
  }
  return out;
}
