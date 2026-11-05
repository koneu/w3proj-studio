// What's placed on a map, as the MCP tool tells about it.

export interface PlacedThing { id: string; position: number[]; angle: number; player?: number; life?: number; hp?: number }

type Names = ReadonlyMap<string, string | undefined>;

/** How many of each type, most first. */
export function placedTypes(all: PlacedThing[], names: Names) {
  const counts = new Map<string, number>();
  for (const p of all) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([id, count]) => ({ id, name: names.get(id), count }));
}

/** Single objects of a type, or an owner's (`player` counts from 1, as players do in the editor). */
export function placedList(all: PlacedThing[], names: Names, id?: string, player?: number) {
  return all
    .filter((p) => (id === undefined || p.id === id) && (player === undefined || p.player === player - 1))
    .map((p) => ({
      id: p.id, name: names.get(p.id), position: p.position, angle: p.angle,
      ...(p.player !== undefined ? { player: p.player + 1 } : {}),
    }));
}
