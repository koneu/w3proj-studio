// The World Editor's keys for what's selected, as commands: their keys are the terrain view's default key bindings
// (extension.json `contributes.keybindings`, which the user can change). Height and scale are for doodads and
// destructables: a unit stands on the ground, at the size its type says.
//
// The defaults: Page Up and Down scale the height (Ctrl: raise and lower), Home and End the width, + and - all of it,
// / and [ turn left, * and ] right, the number pad's 8 2 4 6 and the diagonals 7 9 1 3 (NumLock on) nudge (the World Editor's Edit > Nudge
// Selection; Ctrl and the arrows are its camera's, we-drive 2026-11-13: they moved no object); H and V mirror, R turns a quarter,
// Shift+R back (the selection, or what's being pasted); T turns it toward the pointer (not F, the World Editor's Fog
// Effects; T is none of its terrain view's keys: its View menu, read by we-drive --view-menu, 2026-11-10); Space
// selects the last selection, or nothing; Ctrl+F1 shows it in the Object Editor; Delete and Backspace delete it;
// Ctrl+C, X, V and A copy, cut, paste and select all. Shift with them does the same, as before they were bindings,
// except where Shift is a key of its own (Shift+R).

import type { Turn } from "../../lib/terrain/fragment";
import { listCommandOf } from "../../lib/terrain/objectlist";
import { undoStepOf } from "../../lib/keybindings";
import { CAMERA_COMMANDS } from "./viewmodes";

export type SelectionKey =
  | { raise: number }
  | { rotate: number }
  | { scale: [number, number, number] }
  | { nudge: [number, number] };

const HEIGHT = 16, TURN = 5, SIZE = 0.05, NUDGE = 8;

/** What each selection command does to the selection (with a selection, an editable map and no tab's tool open). */
export const SELECTION_COMMANDS: Readonly<Record<string, SelectionKey>> = {
  "w3.terrain.selection.raise": { raise: HEIGHT },
  "w3.terrain.selection.lower": { raise: -HEIGHT },
  "w3.terrain.selection.moveUp": { nudge: [0, NUDGE] },
  "w3.terrain.selection.moveDown": { nudge: [0, -NUDGE] },
  "w3.terrain.selection.moveLeft": { nudge: [-NUDGE, 0] },
  "w3.terrain.selection.moveRight": { nudge: [NUDGE, 0] },
  "w3.terrain.selection.moveUpLeft": { nudge: [-NUDGE, NUDGE] },
  "w3.terrain.selection.moveUpRight": { nudge: [NUDGE, NUDGE] },
  "w3.terrain.selection.moveDownLeft": { nudge: [-NUDGE, -NUDGE] },
  "w3.terrain.selection.moveDownRight": { nudge: [NUDGE, -NUDGE] },
  "w3.terrain.selection.scaleUp": { scale: [SIZE, SIZE, SIZE] },
  "w3.terrain.selection.scaleDown": { scale: [-SIZE, -SIZE, -SIZE] },
  "w3.terrain.selection.scaleUpXY": { scale: [SIZE, SIZE, 0] },
  "w3.terrain.selection.scaleDownXY": { scale: [-SIZE, -SIZE, 0] },
  "w3.terrain.selection.scaleUpZ": { scale: [0, 0, SIZE] },
  "w3.terrain.selection.scaleDownZ": { scale: [0, 0, -SIZE] },
  "w3.terrain.selection.rotateLeft": { rotate: TURN },
  "w3.terrain.selection.rotateRight": { rotate: -TURN },
};

/** The first selection command's edit among `commands` (what a key is bound to, the winner first), or null. */
export function selectionEditOf(commands: readonly string[]): SelectionKey | null {
  for (const c of commands) if (SELECTION_COMMANDS[c]) return SELECTION_COMMANDS[c];
  return null;
}

/** The quarter turns and mirrors, for the selection and for what's being pasted. */
export const TURN_COMMANDS: Readonly<Record<string, Turn>> = {
  "w3.terrain.selection.mirrorX": "mirrorX",
  "w3.terrain.selection.mirrorY": "mirrorY",
  "w3.terrain.selection.rotate90cw": "cw",
  "w3.terrain.selection.rotate90ccw": "ccw",
};

export function turnOf(commands: readonly string[]): Turn | null {
  for (const c of commands) if (TURN_COMMANDS[c]) return TURN_COMMANDS[c];
  return null;
}

/** The terrain view's other key commands, which act on the selection or the clipboard. */
export const FACE_COMMAND = "w3.terrain.selection.facePointer";
export const RECALL_COMMAND = "w3.terrain.selection.recall";
export const OBJECT_EDITOR_COMMAND = "w3.terrain.selection.viewInObjectEditor";
export const DELETE_COMMAND = "w3.terrain.selection.delete";
export const CLIPBOARD_COMMANDS = { copy: "w3.terrain.copy", cut: "w3.terrain.cut", paste: "w3.terrain.paste", selectAll: "w3.terrain.selectAll" } as const;

/** Escape: ends what is going on, the first of these there is: picking a point for a tool, the paste, the area drawn,
 *  the open tab's own (placing an object, a region or camera selected), facing the pointer; else nothing is selected
 *  (the World Editor's Other - Cancel Paste and Cancel Select Object Mode). */
export const CANCEL_COMMAND = "w3.terrain.cancel";

/** The terrain view's own key commands (camera, selection, clipboard): the view runs them as their keys say, in its own
 *  order (index.ts lateKeys, earlyKeys); as commands (the palette, a key bound outside the view) they act on the terrain
 *  editor in front. Any other command bound under terrainFocus (the View keys) the view runs as a command. */
export const KEY_COMMANDS: ReadonlySet<string> = new Set([
  ...Object.keys(CAMERA_COMMANDS), ...Object.keys(SELECTION_COMMANDS), ...Object.keys(TURN_COMMANDS),
  FACE_COMMAND, RECALL_COMMAND, OBJECT_EDITOR_COMMAND, DELETE_COMMAND, CANCEL_COMMAND, ...Object.values(CLIPBOARD_COMMANDS),
]);

/** What is done while a mouse button is held over the map (the World Editor's mouse controls in Configure Controls):
 *  their defaults are the terrain view's mouse bindings, the middle button pans, the right one turns the camera, Alt and
 *  the left button take the selection to the pointer, Ctrl and the left button turn it toward the pointer. */
export const MOUSE_CONTROLS = {
  translate: "w3.terrain.camera.translate",
  rotate: "w3.terrain.camera.rotate",
  moveToPointer: "w3.terrain.selection.moveToPointer",
  rotateToPointer: "w3.terrain.selection.rotateToPointer",
} as const;
export type MouseControl = keyof typeof MOUSE_CONTROLS;

/** Held with the left button, a drag selects an area of ground instead of drawing a box (A by default). */
export const AREA_COMMAND = "w3.terrain.selection.area";

/** Controls that are held, not run: a mouse button's, and the area key's. As commands they only say how they're used. */
export const HELD_COMMANDS: ReadonlySet<string> = new Set([...Object.values(MOUSE_CONTROLS), AREA_COMMAND]);

/** The mouse control of a button pressed: the first among `commands` (what it's bound to, the winner first) that
 *  `usable` allows (the selection's need a selection), or null. */
export function mouseControlOf(commands: readonly string[], usable: (c: MouseControl) => boolean): MouseControl | null {
  for (const id of commands) {
    const c = (Object.keys(MOUSE_CONTROLS) as MouseControl[]).find((k) => MOUSE_CONTROLS[k] === id);
    if (c && usable(c)) return c;
  }
  return null;
}

/** Whether the view runs a command bound under terrainFocus as a command (the View keys, the user's own): not its own
 *  key commands, held controls or the tabs' list commands, which it handles itself, nor Undo and Redo, whose keys
 *  (under undoKeys, which the editor around the view gives too) its editor's own handler takes: run here as well, a
 *  key would step twice. */
export const runsAsCommand = (id: string) => !KEY_COMMANDS.has(id) && !HELD_COMMANDS.has(id) && listCommandOf([id]) === null && undoStepOf([id]) === null;

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
