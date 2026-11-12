// Moving placed objects: the undo step for a move, and keeping a moved group on the map.

/** Where an object stands and how it faces; `flags` only for doodads, whose fixed-height flag a move may clear. */
export interface Pose { position: [number, number, number]; angle: number; flags?: number }
export interface Bounds { left: number; right: number; bottom: number; top: number }

export interface MoveDeps<E> {
  setPlacement(entry: E, position: [number, number, number], angle: number, flags?: number): void;
  /** Redraws the selection rings after the entries moved. */
  refreshRings(): void;
  pushEdit(edit: { undo: () => void; redo: () => void; terrain: false; objects: false }): void;
}

/** One undo step for moving or turning entries that are already where they now stand (`poseOf` gives the
 *  pose after). The rings follow them now, and after every undo and redo. */
export function pushMoveEdit<E>(entries: E[], before: Pose[], after: Pose[], deps: MoveDeps<E>) {
  const apply = (poses: Pose[]) => {
    entries.forEach((e, i) => deps.setPlacement(e, [...poses[i].position], poses[i].angle, poses[i].flags));
    deps.refreshRings();
  };
  deps.pushEdit({ undo: () => apply(before), redo: () => apply(after), terrain: false, objects: false });
  deps.refreshRings();
}

/** The shift (dx, dy) cut back so that every point stays inside its bounds, all by the same amount: a
 *  group keeps its shape and stops at the edge together. A point already outside its bounds doesn't hold
 *  the others back. */
export function clampShift(points: readonly (readonly [number, number])[], bounds: readonly Bounds[], dx: number, dy: number): [number, number] {
  let loX = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity;
  points.forEach(([x, y], i) => {
    const b = bounds[i];
    if (x < b.left || x > b.right || y < b.bottom || y > b.top) return;
    loX = Math.max(loX, b.left - x); hiX = Math.min(hiX, b.right - x);
    loY = Math.max(loY, b.bottom - y); hiY = Math.min(hiY, b.top - y);
  });
  return [Math.min(Math.max(dx, loX), hiX), Math.min(Math.max(dy, loY), hiY)];
}
