// Moving placed objects: the undo step for a move, and keeping a moved group on the map.

export interface Pose { position: [number, number, number]; angle: number }


export interface MoveDeps<E> {
  setPlacement(entry: E, position: [number, number, number], angle: number): void;
  /** Redraws the selection rings after the entries moved. */
  refreshRings(): void;
  pushEdit(edit: { undo: () => void; redo: () => void; terrain: false; objects: false }): void;
}

/** One undo step for moving or turning entries that are already where they now stand (`poseOf` gives the
 *  pose after). The rings follow them now, and after every undo and redo. */
export function pushMoveEdit<E>(entries: E[], before: Pose[], after: Pose[], deps: MoveDeps<E>) {
  const apply = (poses: Pose[]) => {
    entries.forEach((e, i) => deps.setPlacement(e, [...poses[i].position], poses[i].angle));
    deps.refreshRings();
  };
  deps.pushEdit({ undo: () => apply(before), redo: () => apply(after), terrain: false, objects: false });
  deps.refreshRings();
}
