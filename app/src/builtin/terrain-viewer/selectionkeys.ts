// The World Editor's keys for what's selected. Height and scale are for doodads and destructables:
// a unit stands on the ground, at the size its type says.

import { keyOf } from "../../lib/keys";
import type { Turn } from "../../lib/terrain/fragment";

export type SelectionKey =
  | { raise: number }
  | { rotate: number }
  | { scale: [number, number, number] }
  | { nudge: [number, number] };

const HEIGHT = 16, TURN = 15, SIZE = 0.05, NUDGE = 32;

type Keys = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

export function selectionKey(e: Keys): SelectionKey | null {
  if (e.altKey) return null;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = keyOf(e);
  if (key === "PageUp") return ctrl ? { raise: HEIGHT } : { scale: [0, 0, SIZE] };
  if (key === "PageDown") return ctrl ? { raise: -HEIGHT } : { scale: [0, 0, -SIZE] };
  if (ctrl) {
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, NUDGE], ArrowDown: [0, -NUDGE],
      Numpad4: [-NUDGE, 0], Numpad6: [NUDGE, 0], Numpad8: [0, NUDGE], Numpad2: [0, -NUDGE],
    };
    const move = nudge[e.code] ?? nudge[key];
    return move ? { nudge: move } : null;
  }
  if (key === "Home") return { scale: [SIZE, SIZE, 0] };
  if (key === "End") return { scale: [-SIZE, -SIZE, 0] };
  if (key === "+") return { scale: [SIZE, SIZE, SIZE] };
  if (key === "-") return { scale: [-SIZE, -SIZE, -SIZE] };
  if (key === "/") return { rotate: TURN };
  if (key === "*") return { rotate: -TURN };
  return null;
}

type PlainKeys = Keys & { shiftKey: boolean };

/** Space alone: selects the last selected object, or deselects. */
export const isRecallKey = (e: PlainKeys) => keyOf(e) === " " && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

/** Studio's key for turning the selection toward the pointer ("Face point"). Not F, the World Editor's Fog Effects;
 *  T is none of its terrain view's keys (its View menu, read by we-drive --view-menu, 2026-11-10). */
export const FACE_KEY = "T";
/** T alone (Shift too, for caps lock's sake): the selection turns toward the pointer. Ctrl+T is View > Terrain. */
export const isFaceKey = (e: Keys) => keyOf(e).toUpperCase() === FACE_KEY && !e.ctrlKey && !e.metaKey && !e.altKey;

/** Ctrl+F1: the selection in the Object Editor. */
export const isObjectEditorKey = (e: Keys) => keyOf(e) === "F1" && (e.ctrlKey || e.metaKey) && !e.altKey;

/** H and V mirror, R turns a quarter, Shift+R back: for the selection and for what's being pasted. */
export function turnKey(e: PlainKeys): Turn | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (keyOf(e).toLowerCase()) {
    case "h": return "mirrorX";
    case "v": return "mirrorY";
    case "r": return e.shiftKey ? "ccw" : "cw";
    default: return null;
  }
}

/** A scale after a step, never so small the object is gone. */
export const scaled = (scale: readonly number[], step: readonly number[]): [number, number, number] =>
  [0, 1, 2].map((i) => Math.round(Math.max(0.05, (scale[i] ?? 1) + step[i]) * 1000) / 1000) as [number, number, number];

/** Flag of a doodad whose height is its own, not the ground's: seen on thousands of ladder doodads. */
export const FIXED_HEIGHT = 4;
/** Flag of a doodad past the playable map: every doodad out there has it on ladder maps, and no other. */
export const OUTSIDE_PLAYABLE = 1;

/** A doodad's flags for where it stands. */
export const borderFlags = (flags: number, outside: boolean) => (outside ? flags | OUTSIDE_PLAYABLE : flags & ~OUTSIDE_PLAYABLE);

export interface Step { undo(): void; redo(): void; terrain: boolean; objects: boolean }

/** Two undo steps as one: a held key's repeats join its first press. */
export const joinSteps = (first: Step, then: Step): Step => ({
  undo: () => { then.undo(); first.undo(); },
  redo: () => { first.redo(); then.redo(); },
  terrain: first.terrain || then.terrain,
  objects: first.objects || then.objects,
});
