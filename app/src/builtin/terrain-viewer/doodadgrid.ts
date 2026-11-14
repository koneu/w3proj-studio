// Where the World Editor puts a doodad or destructable when it opens a map: on its own grid, worked out from its
// pathing texture. Measured with we-drive (2026-11-13, a copy of empty_map_on_newest_world_editor.w3m with 340
// doodads off their grids, opened and saved by the editor; doodadgrid.test.ts has the measured cases) and borne out
// by every doodad with a pathing texture on the 14 maps of smoketest_maps (44 390 of 44 390):
// - a type with a pathing texture stands on the building grid of its texture's size (placement.ts onBuildingGrid):
//   its texture's edges on the 64 grid, so a 2×2 or 6×6 one at 64n + 32, a 4×4 or 8×8 one at 64n, each axis on its
//   own, the nearest such point, halves upwards (-3328 goes to -3296 on the 64n + 32 grid, -3040 to -3008 on 64n);
// - the texture is drawn for the default facing 270°: at a quarter turn of 0° or 180° its width lies along y;
// - a type whose texture isn't square also turns to the nearest quarter turn (all 73 such on those maps are), and so
//   does a square one whose pixels aren't all one colour (we-drive 2026-11-14, doodad-snap-custom-tex / -col specs, map
//   textures of 4×4: ring, corner, row, diagonal, half, cross, quadrants, and a magenta one with a single red, green or
//   blue pixel all turn; all magenta, red, green, blue, black or white keep; the game's 1x1Default and 2x1Default are
//   2×2 pictures with one and two magenta pixels and turn, 2x2Default is all magenta and keeps). Their places come
//   from the picture's size as before. Whether the alpha counts is not measured (the game's own are uniform);
// - a plain square one keeps its angle;
// - a type without a pathing texture (none, _) stays where it is.
// The facing (we-drive, verification round 3 package 6, 2026-11-13; doodadgrid.test.ts):
// - a destructable whose type has a fixed rotation (fixedRot / bfxr 0 or more) faces it, whatever it was stored with
//   (trees LTlt 30, -90, 400 to 270; tree bridges LTt0 -30, 450, -90 to 0, also before their quarter turn). A doodad's
//   fixed rotation isn't enforced (YZef 30 stays 30);
// - a destructable's fixed rotation holds only when its type has a pathing texture: with none (bptx _) the angle is
//   only brought into 0..360 as any other (we-drive 2026-11-14, doodad-snap-custom-more spec: bfxr 90 and 0 with _ stay
//   at 0.4 and 2.9, bfxr 90, 270, 0 on a 2x2, 1x1, 4x4 and 2x1 texture face it, bfxr -1 on 2x2 keeps);
// - any other angle that isn't turned to a quarter is brought into 0..360 by whole turns in single precision, a
//   doodad's and a destructable's alike, with or without a texture: -90 to 270, 450 to 90, 720 and 1080 to 360 (not
//   0: only above 360 is taken down), -720 to 0. A quarter turn comes from the stored angle (LOch -45 goes to 0, not
//   the 270 of its 315).
// The editor doesn't count this as a change (closing it asks nothing), but its next save writes the new places.

import { onBuildingGrid } from "./placement";
import type { Placed } from "./objects";

/** A pathing texture's size in cells. */
export interface PathSize {
  width: number; height: number;
  /** The picture has more than one colour (a square one then turns to a quarter, as a rectangle does). */
  mixed?: boolean;
}

/** True when the picture's pixels (RGBA, row after row) aren't all one colour; alpha isn't looked at. */
export function mixedPicture(rgba: ArrayLike<number>): boolean {
  for (let i = 4; i + 2 < rgba.length; i += 4) if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2]) return true;
  return false;
}

const QUARTER = Math.fround(Math.PI / 2);

/** The quarter turn (0 to 3, counter-clockwise from east) the World Editor rounds an angle to. Worked out in single
 *  precision, as its own arithmetic: 45° goes to 90°, 135° to 180°, 225° to 270°, but 315° (stored a hair under) to
 *  270° and 315.1° to 0° (measured). */
export function quarterTurn(angle: number): number {
  const q = Math.floor(Math.fround(Math.fround(Math.fround(angle) / QUARTER) + 0.5));
  return ((q % 4) + 4) % 4;
}

const TURN = Math.fround(2 * Math.PI);
/** Beyond this many turns an angle is taken down by a remainder, not turn by turn (a broken file can't hang it). */
const MAX_TURNS = 4096;

/** An angle (radians) brought into 0..2π as the World Editor does, by whole turns in single precision: only above
 *  2π is taken down, so 720° stays 360°; below 0 is brought up, -720° to 0. As it was when it isn't finite. */
export function wholeTurns(angle: number): number {
  let a = Math.fround(angle);
  if (!Number.isFinite(a)) return angle;
  if (Math.abs(a) > MAX_TURNS * TURN) a = Math.fround(a % TURN);
  while (a > TURN) a = Math.fround(a - TURN);
  while (a < 0) a = Math.fround(a + TURN);
  return a;
}

/** The angle (radians, single precision) of a fixed rotation in degrees (fixedRot). */
export function fixedAngle(degrees: number): number {
  return Math.fround((degrees * Math.PI) / 180);
}

/** Where the World Editor puts a doodad of pathing size `size` (null: no pathing texture) that is stored at (x, y)
 *  with `angle` (radians), and the angle it turns it to. `fixedRot`: a destructable type's fixed rotation in degrees
 *  (null: none, and always for doodads, whose fixed rotation the editor doesn't enforce); it only holds with a texture. */
export function doodadOnGrid(x: number, y: number, angle: number, size: PathSize | null, fixedRot: number | null = null): { x: number; y: number; angle: number } {
  // Compared as the file stores them (single precision): the JSON's 3.1415927 is the file's π, and stays as written.
  const keep = (was: number, now: number) => (Math.fround(was) === now ? was : now);
  if (!Number.isFinite(angle)) return { x, y, angle };
  const hasSize = !!size && size.width >= 1 && size.height >= 1;
  const facing = hasSize && fixedRot !== null && Number.isFinite(fixedRot) && fixedRot >= 0 ? fixedAngle(fixedRot) : angle;
  if (!size || !(size.width >= 1) || !(size.height >= 1) || !Number.isFinite(x) || !Number.isFinite(y)) return { x, y, angle: keep(angle, wholeTurns(facing)) };
  const q = quarterTurn(facing);
  // The textures are drawn for 270°: turned by a quarter (0° or 180°), the width lies along y.
  const across = q % 2 === 0;
  const cellsX = across ? size.height : size.width, cellsY = across ? size.width : size.height;
  const quarter = Math.fround((q * Math.PI) / 2);
  const turned = keep(angle, size.width === size.height && !size.mixed ? wholeTurns(facing) : quarter);
  return { x: keep(x, onBuildingGrid(x, cellsX)), y: keep(y, onBuildingGrid(y, cellsY)), angle: turned };
}

/** The doodads of a list the World Editor would move or turn when it opens the map, with where to. `sizeOf`: an
 *  id's pathing texture size, null for none; `fixedRotOf`: a destructable type's fixed rotation (doodadOnGrid). */
export function doodadSnaps(list: readonly Placed[], sizeOf: (id: string) => PathSize | null,
  fixedRotOf: (id: string) => number | null = () => null): { entry: Placed; x: number; y: number; angle: number }[] {
  const out: { entry: Placed; x: number; y: number; angle: number }[] = [];
  for (const entry of list) {
    const [x, y] = entry.position;
    const at = doodadOnGrid(x, y, entry.angle, sizeOf(entry.id), fixedRotOf(entry.id));
    if (at.x !== x || at.y !== y || at.angle !== entry.angle) out.push({ entry, ...at });
  }
  return out;
}
