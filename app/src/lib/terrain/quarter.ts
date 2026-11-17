// The World Editor's angle arithmetic for doodads: single precision, as its own. Shared by the doodad grid (where it
// turns a doodad when it opens a map) and the pathing map (which way round a texture is stamped).

const QUARTER = Math.fround(Math.PI / 2);
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

/** The quarter turn (0 to 3, counter-clockwise from east) the World Editor rounds an angle to. The angle is brought
 *  into 0..2π by whole turns first, then worked out in single precision, as its own arithmetic: 45° goes to 90°,
 *  135° to 180°, 225° to 270°, but 315° (stored a hair under) to 270° and 315.1° to 0° (measured). The turns taken
 *  off count: 405° and 765° (a hair under 45° once reduced) go to 0°, 675° to 270° (we-compare fence-exact,
 *  2026-11-17). 0 when the angle isn't finite. */
export function quarterTurn(angle: number): number {
  const a = wholeTurns(angle);
  if (!Number.isFinite(a)) return 0;
  const q = Math.floor(Math.fround(Math.fround(a / QUARTER) + 0.5));
  return ((q % 4) + 4) % 4;
}
