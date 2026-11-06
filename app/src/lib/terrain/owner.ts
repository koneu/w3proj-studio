// The player field of war3mapUnits.doo holds more than the owner: the low 16 bits are the player,
// and bit 16 says an Ancient is placed uprooted. Everything that shows or edits an owner uses the
// low half; the flags go back into the file unchanged.

interface Owned { player?: number; playerFlags?: number }

const OWNER = 0xffff;

export const ownerOf = <T extends number | undefined>(player: T): T => (player === undefined ? player : ((player & OWNER) as T));

/** Replaces each entry's field by its owner, keeping the rest in `playerFlags` until saving. */
export function splitOwners(list: Owned[]): void {
  for (const e of list) {
    const p = e.player;
    if (p === undefined || p <= OWNER) continue;
    e.player = p & OWNER;
    e.playerFlags = p - e.player;
  }
}

/** An entry as the file has it. */
export function joinOwners<T extends Owned>(e: T): T {
  const { playerFlags, ...rest } = e;
  return (playerFlags === undefined ? e : { ...rest, player: (e.player ?? 0) + playerFlags }) as T;
}

/** The document as JSON, with the flags back in the player field. */
export function placedText(doc: unknown): string {
  return JSON.stringify(doc, (_, v: unknown) => (v && typeof v === "object" && "playerFlags" in v ? joinOwners(v as Owned) : v));
}
