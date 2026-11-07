// Heights of placed doodads, with no editor state: what a paste keeps of the height over the ground. A doodad with
// FIXED_HEIGHT (flag 4) has a height of its own; any other stands on the ground, and follows it when the ground is edited.

import { FIXED_HEIGHT } from "./selectionkeys";

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
