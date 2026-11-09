// Heights of placed doodads, with no editor state: what a paste keeps of the height over the ground,
// Set Uniform Doodad Heights and Reset Fixed Object Heights. A doodad with FIXED_HEIGHT (flag 4) has a
// height of its own; any other stands on the ground, and follows it when the ground is edited.

import { DEEP_WATER } from "../../lib/terrain/pathing";
import { FIXED_HEIGHT } from "./selectionkeys";

/** What of a placed object these functions read. */
export interface HeightHolder { position: readonly number[]; flags?: number }
/** What they change: the same two fields. */
export interface HeightChange { position: [number, number, number]; flags: number }

/** The flags a doodad has when none were read: placed, visible (as a new doodad). */
const PLAIN = 2;
const isFixed = (p: HeightHolder) => ((p.flags ?? 0) & FIXED_HEIGHT) !== 0;

/** A pasted object's height: a fixed one keeps its height over the ground when `preserve`, anything
 *  else stands on the ground. `offset` is its height over the ground where it was copied. */
export function pastedHeight(ground: number, offset: number, fixed: boolean, preserve: boolean): number {
  return fixed && preserve ? ground + offset : ground;
}

/** A pasted object's flags: without preserving, a fixed height is dropped, so the copy stands on the
 *  ground and follows it, like any doodad that was never given a height. */
export function pastedFlags(flags: number, preserve: boolean): number {
  return preserve ? flags : flags & ~FIXED_HEIGHT;
}

/** Movement types (UnitData.slk `movetp`, object data `umvt`) whose units the game puts on the water surface:
 *  ships always, amphibious units where they are in water. */
const ON_WATER = new Set(["float", "amph"]);
export const goesOnWater = (moveType: string | undefined) => !!moveType && ON_WATER.has(moveType.toLowerCase());

/** Whether a placed object's drawn height comes from its movement type rather than the height the placement file
 *  holds: any unit type with one (UnitData.slk `movetp`; buildings have "_"). */
export const heightByMoveType = (moveType: string | undefined) => !!moveType;

/** Where a unit is drawn in height. The World Editor places a unit by its type, not by the height the placement file
 *  holds (we-drive, 2026-11-09, on copies of 03_Water_Ford_Lake_Boats): at its flying height (UnitData.slk
 *  `moveHeight`, object data `umvh`: `lift.height`) over the ground under it (`lift.ground`, heightAt: the bed under
 *  water, the cliff as it's drawn), whatever its movement type: footmen stored at 0, 256 and 600 on ground 256 stood on
 *  the ground alike, as did gryphons (flying height 240) stored at those heights 240 over it; a footman and a banshee
 *  given 300 in the map's object data and a gryphon given 600 were drawn that high; a gryphon over the lake is 240 over
 *  its bed, its shadow close under it on the water. A floating or amphibious unit over water (`surface`, from
 *  waterSurfaceAt; null without) sits on the surface where that is higher (map 03's ships hold the sea bed's height).
 *  Without `lift` (an object whose type isn't known as a unit) the stored height counts. */
export function unitDrawHeight(moveType: string | undefined, stored: number, surface: number | null,
  lift?: { ground: number; height: number }): number {
  const base = lift && heightByMoveType(moveType) ? lift.ground + (Number.isFinite(lift.height) ? lift.height : 0) : stored;
  return goesOnWater(moveType) && surface !== null && surface > base ? surface : base;
}

/** Whether a unit is drawn swimming (the "swim" look of its model: Stand Swim, with the body under the surface and,
 *  in the classic models, a ripple ring): an amphibious unit where the water is deeper than units can walk
 *  (`ground`, `surface`: heights under it; DEEP_WATER, the pathing's). The World Editor (we-drive, 2026-11-08, map 03
 *  with naga at depths 24, 45, 62, 66 and 102) shows those at 62 and more swimming, the others standing. */
export function unitSwims(moveType: string | undefined, ground: number, surface: number | null): boolean {
  return moveType?.toLowerCase() === "amph" && surface !== null && surface - ground > DEEP_WATER;
}

/** The looks a placed unit stands in besides its type's Animprops: an Ancient placed uprooted in its model's
 *  Alternate animations (Stand Alternate: on its legs, roots out of the ground, as the World Editor shows it), a
 *  swimming unit in its Swim ones. */
export function unitLooks(uprooted: boolean, swimming: boolean): string[] {
  return [...(uprooted ? ["alternate"] : []), ...(swimming ? ["swim"] : [])];
}

/** A number typed for a height, or null: it has to be finite. A comma may be the decimal mark. */
export function parseHeight(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Set Uniform Doodad Heights for one doodad: it stands at `z` with a height of its own. Null when it
 *  does so already. */
export function uniformHeight(p: HeightHolder, z: number): HeightChange | null {
  if (isFixed(p) && p.position[2] === z) return null;
  return { position: [p.position[0], p.position[1], z], flags: (p.flags ?? PLAIN) | FIXED_HEIGHT };
}

/** Reset Fixed Object Heights for one object: if it has a height of its own, it goes onto the ground
 *  there (`ground` is the ground's height under it) and follows it again. Null for any other object. */
export function resetFixedHeight(p: HeightHolder, ground: number): HeightChange | null {
  if (!isFixed(p)) return null;
  return { position: [p.position[0], p.position[1], ground], flags: (p.flags ?? PLAIN) & ~FIXED_HEIGHT };
}
