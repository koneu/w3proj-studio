// The World Editor's keys for what's selected. Height and scale are for doodads and destructables:
// a unit stands on the ground, at the size its type says.

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
  if (e.key === "PageUp") return ctrl ? { raise: HEIGHT } : { scale: [0, 0, SIZE] };
  if (e.key === "PageDown") return ctrl ? { raise: -HEIGHT } : { scale: [0, 0, -SIZE] };
  if (ctrl) {
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, NUDGE], ArrowDown: [0, -NUDGE],
      Numpad4: [-NUDGE, 0], Numpad6: [NUDGE, 0], Numpad8: [0, NUDGE], Numpad2: [0, -NUDGE],
    };
    const move = nudge[e.code] ?? nudge[e.key];
    return move ? { nudge: move } : null;
  }
  if (e.key === "Home") return { scale: [SIZE, SIZE, 0] };
  if (e.key === "End") return { scale: [-SIZE, -SIZE, 0] };
  if (e.key === "+") return { scale: [SIZE, SIZE, SIZE] };
  if (e.key === "-") return { scale: [-SIZE, -SIZE, -SIZE] };
  if (e.key === "/") return { rotate: TURN };
  if (e.key === "*") return { rotate: -TURN };
  return null;
}

type PlainKeys = Keys & { shiftKey: boolean };

/** Space alone: selects the last selected object, or deselects. */
export const isRecallKey = (e: PlainKeys) => e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

/** Ctrl+F1: the selection in the Object Editor. */
export const isObjectEditorKey = (e: Keys) => e.key === "F1" && (e.ctrlKey || e.metaKey) && !e.altKey;

/** A scale after a step, never so small the object is gone. */
export const scaled = (scale: readonly number[], step: readonly number[]): [number, number, number] =>
  [0, 1, 2].map((i) => Math.round(Math.max(0.05, (scale[i] ?? 1) + step[i]) * 1000) / 1000) as [number, number, number];

/** Flag of a doodad whose height is its own, not the ground's: seen on thousands of ladder doodads. */
export const FIXED_HEIGHT = 4;
/** Flag of a doodad past the playable map: every doodad out there has it on ladder maps, and no other. */
export const OUTSIDE_PLAYABLE = 1;
