// Finds the placed object an outside caller (the Object Manager) means: by id and creation number
// when that is unique, else by id and position. Two objects at one spot stay apart through the number.

export interface PlacedRef { id?: string; editorId?: number; x: number; y: number }
export interface PlacedLike { id: string; editorId?: number; position: number[] }

const SAME_SPOT = 0.5;

/** Index of the match in `list`, or -1. */
export function matchPlaced(list: readonly PlacedLike[], ref: PlacedRef): number {
  const sameId = (p: PlacedLike) => ref.id === undefined || p.id === ref.id;
  const here = (p: PlacedLike) => Math.abs(p.position[0] - ref.x) <= SAME_SPOT && Math.abs(p.position[1] - ref.y) <= SAME_SPOT;
  if (ref.editorId !== undefined) {
    // A creation number held once is the object, wherever it has moved to since.
    const same = list.map((p, i) => (sameId(p) && p.editorId === ref.editorId ? i : -1)).filter((i) => i >= 0);
    if (same.length === 1) return same[0];
    const i = same.find((k) => here(list[k]));
    if (i !== undefined) return i;
  }
  return list.findIndex((p) => sameId(p) && here(p));
}
