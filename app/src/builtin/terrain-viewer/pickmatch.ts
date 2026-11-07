// Finds the placed object an outside caller (the Object Manager) means: by id and creation number
// when it has them, else by id and position. Two objects at one spot stay apart through the number.

export interface PlacedRef { id?: string; editorId?: number; x: number; y: number }
export interface PlacedLike { id: string; editorId?: number; position: number[] }

const SAME_SPOT = 0.5;

/** Index of the match in `list`, or -1. */
export function matchPlaced(list: readonly PlacedLike[], ref: PlacedRef): number {
  const sameId = (p: PlacedLike) => ref.id === undefined || p.id === ref.id;
  const here = (p: PlacedLike) => Math.abs(p.position[0] - ref.x) <= SAME_SPOT && Math.abs(p.position[1] - ref.y) <= SAME_SPOT;
  if (ref.editorId !== undefined) {
    const i = list.findIndex((p) => sameId(p) && p.editorId === ref.editorId && here(p));
    if (i >= 0) return i;
  }
  return list.findIndex((p) => sameId(p) && here(p));
}
