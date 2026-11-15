// Where the World Editor puts a doodad or destructable when it opens a map: on its own grid, worked out from its
// pathing texture. Measured with we-drive (2026-11-13, a copy of empty_map_on_newest_world_editor.w3m with 340
// doodads off their grids, opened and saved by the editor; doodadgrid.test.ts has the measured cases) and borne out
// by every doodad with a pathing texture on the 14 maps of smoketest_maps (44 390 of 44 390):
// - a type with a pathing texture stands on the grid of its texture's size (onDoodadGrid, the building grid for even
//   sizes): a 2×2 or 6×6 one at 64n + 32, a 4×4 or 8×8 one at 64n, an odd count as the even one below it (1 as 0, 3 as
//   2: a 1×1 or 4×1 picture on 64n, a 3×3 on 64n + 32), each axis on its own, the nearest such point, halves upwards (-3328 goes to -3296 on the 64n + 32 grid, -3040 to -3008 on 64n);
// - the texture is drawn for the default facing 270°: at a quarter turn of 0° or 180° its width lies along y;
// - a type whose texture isn't square also turns to the nearest quarter turn (all 73 such on those maps are), and so
//   does a square one whose pixels aren't all one colour (we-drive 2026-11-14, doodad-snap-custom-tex / -col specs, map
//   textures of 4×4: ring, corner, row, diagonal, half, cross, quadrants, and a magenta one with a single red, green or
//   blue pixel all turn; all magenta, red, green, blue, black or white keep; the game's 1x1Default and 2x1Default are
//   2×2 pictures with one and two magenta pixels and turn, 2x2Default is all magenta and keeps). Their places come
//   from the picture's size as before. The alpha counts: one colour partly transparent turns (doodad-snap-custom-alpha);
// - a type whose map-named texture is missing (the pathing map then uses the type's own) stays where it is;
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
// - before any of this the stored angle is read as the editor reads it: a whole number as degrees, -1 as 135°
//   (openedAngle), doodads, destructables and units alike (units: openedUnitAngle).
// The editor doesn't count this as a change (closing it asks nothing), but its next save writes the new places.

import type { Placed } from "./objects";

/** A pathing texture's size in cells. */
export interface PathSize {
  width: number; height: number;
  /** The picture has more than one colour (a square one then turns to a quarter, as a rectangle does). */
  mixed?: boolean;
}

/** True when the picture's pixels (RGBA, row after row) aren't all one colour, the alpha counted: a magenta picture
 *  partly transparent is mixed (we-drive 2026-11-14, doodad-snap-custom-alpha spec: 32-bit magenta, red and black
 *  4×4 pictures with half, one pixel or a ring transparent all turn to the quarter). */
export function mixedPicture(rgba: ArrayLike<number>): boolean {
  for (let i = 4; i + 3 < rgba.length; i += 4) {
    if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2] || rgba[i + 3] !== rgba[3]) return true;
  }
  return false;
}

/** The pathing size the snap goes by, from what a type's texture lookup found (PathingData.placedImage): null when
 *  there's no picture, and also when the map's own texture is missing and the type's from the game's table stood in
 *  for it (`fellBackTo`): the World Editor then leaves the doodad or destructable where it stands, place and angle
 *  (we-drive 2026-11-14, doodad-snap-custom-missing spec: D300 and B300 on Custom\own-missing4.tga stay at -1486.5,
 *  521.25, 0.4), though its pathing map uses the stand-in. */
export function snapSize(found: { image: { width: number; height: number; rgba: ArrayLike<number> } | null; fellBackTo?: string }): PathSize | null {
  const { image } = found;
  if (!image || found.fellBackTo !== undefined) return null;
  return { width: image.width, height: image.height, mixed: mixedPicture(image.rgba) };
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

/** The nearest point of the doodad grid for a texture `cells` pixels across: 64n plus the middle of the texture, which
 *  for an odd count is the whole cell below it (we-drive 2026-11-14, spec doodad-snap-grid, all 480 placements of
 *  pictures 1 to 8 across and high at 0° and 90°: 1 goes to 64n, 2 and 3 to 64n + 32, 4 and 8 to 64n, so 3 isn't 48).
 *  A building's grid (onBuildingGrid) is the same for even counts only. Halves go upwards. */
export function onDoodadGrid(v: number, cells: number): number {
  const half = Math.floor(cells / 2) * 32;
  return Math.round((v - half) / 64) * 64 + half;
}

/** Whether a pathing size puts a doodad on a grid (doodadOnGrid): a texture at least a pixel each way. */
export const hasPathSize = (size: PathSize | null | undefined): size is PathSize => !!size && size.width >= 1 && size.height >= 1;

/** Where the World Editor puts a doodad of pathing size `size` (null: no pathing texture) that is stored at (x, y)
 *  with `angle` (radians), and the angle it turns it to. `fixedRot`: a destructable type's fixed rotation in degrees
 *  (null: none, and always for doodads, whose fixed rotation the editor doesn't enforce); it only holds with a texture. */
export function doodadOnGrid(x: number, y: number, angle: number, size: PathSize | null, fixedRot: number | null = null): { x: number; y: number; angle: number } {
  // Compared as the file stores them (single precision): the JSON's 3.1415927 is the file's π, and stays as written.
  const keep = (was: number, now: number) => (Math.fround(was) === now ? was : now);
  if (!Number.isFinite(angle)) return { x, y, angle };
  const hasSize = hasPathSize(size);
  const facing = hasSize && fixedRot !== null && Number.isFinite(fixedRot) && fixedRot >= 0 ? fixedAngle(fixedRot) : angle;
  if (!size || !(size.width >= 1) || !(size.height >= 1) || !Number.isFinite(x) || !Number.isFinite(y)) return { x, y, angle: keep(angle, wholeTurns(facing)) };
  const q = quarterTurn(facing);
  // The textures are drawn for 270°: turned by a quarter (0° or 180°), the width lies along y.
  const across = q % 2 === 0;
  const cellsX = across ? size.height : size.width, cellsY = across ? size.width : size.height;
  const quarter = Math.fround((q * Math.PI) / 2);
  const turned = keep(angle, size.width === size.height && !size.mixed ? wholeTurns(facing) : quarter);
  return { x: keep(x, onDoodadGrid(x, cellsX)), y: keep(y, onDoodadGrid(y, cellsY)), angle: turned };
}

/** What the World Editor reads a stored -1 as: 135° (fence-neg, fence-dest, 2026-11-15). */
const MINUS_ONE_ANGLE = Math.fround((3 * Math.PI) / 4);

/** The angle (radians) the World Editor takes a stored angle for when it opens a map: a whole number is read as degrees,
 *  and -1 as 135° (we-compare specs fence-ints, fence-neg and fence-dest, 2026-11-15: 1 to 7, 45, 90, 180, 270, 360,
 *  361, 720 and -2, -3, -45, -90, -180, -360 on a rectangle NOfl, a plain square LOcb and a doodad without a texture
 *  APms, and 1, 2, 3, 90, 180, 270, -2 on the destructables LTbr, YTpl, LTcr and OTsp, all as degrees; -1 on all seven
 *  types, three copies each, as 135, so the NOfl and YTpl turn to 180; 2.0000002, 1.9999999, -0.5 and -3.14159 stay
 *  radians). Doodads and destructables alike. */
export function openedAngle(angle: number): number {
  const a = Math.fround(angle);
  if (a === -1) return MINUS_ONE_ANGLE;
  return Number.isInteger(a) && a !== 0 ? fixedAngle(a) : angle;
}

/** The facing the World Editor gives a unit (or anything else of war3mapUnits.doo) stored at `angle` when it opens a map:
 *  read as a doodad's (openedAngle: a whole number as degrees, -1 as 135°), then brought into 0..360 by whole turns
 *  (wholeTurns: 360 stays 360). Measured on gold mines, taverns, goblin merchants, barracks and footmen (we-compare
 *  neutral-facing and neutral-facing-neg, 2026-11-15: 2 and 3 to 2° and 3°, 0.5, 90° and 5.5 kept, -1 to 135°, -0.5 to
 *  5.78, -2.0725 to 4.21, 400 to 40°, 6.5 to 0.217, 360 to 6.2831855). As stored when that is the same in single
 *  precision, so an angle in range isn't rewritten. */
export function openedUnitAngle(angle: number): number {
  if (!Number.isFinite(angle)) return angle;
  const now = wholeTurns(openedAngle(angle));
  return Math.fround(angle) === now ? angle : now;
}

/** The doodads and destructables of a list the World Editor would move or turn when it opens the map, with where to.
 *  `sizeOf`: an id's pathing texture size, null for none; `fixedRotOf`: a destructable type's fixed rotation
 *  (doodadOnGrid). The stored angle is read as the editor reads it (openedAngle). */
export function doodadSnaps(list: readonly Placed[], sizeOf: (id: string) => PathSize | null,
  fixedRotOf: (id: string) => number | null = () => null): { entry: Placed; x: number; y: number; angle: number }[] {
  const out: { entry: Placed; x: number; y: number; angle: number }[] = [];
  for (const entry of list) {
    const [x, y] = entry.position;
    const at = doodadOnGrid(x, y, openedAngle(entry.angle), sizeOf(entry.id), fixedRotOf(entry.id));
    if (at.x !== x || at.y !== y || at.angle !== entry.angle) out.push({ entry, ...at });
  }
  return out;
}
