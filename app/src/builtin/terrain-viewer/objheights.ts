// Heights of placed doodads, with no editor state: what a paste keeps of the height over the ground,
// Set Uniform Doodad Heights and Reset Fixed Object Heights. A doodad with FIXED_HEIGHT (flag 4) has a
// height of its own; any other stands on the ground, and follows it when the ground is edited.

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
