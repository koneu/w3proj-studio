// Groups of placed things that stand close together: each member is within `gap` of another member of its group
// (single linkage), as creeps make up a camp. Used by the melee check's camps and the Item Drops overview.

/** The items in groups, in the order they were given (a group's first member is its first item). */
export function clusterNear<T>(items: readonly T[], at: (item: T) => readonly [number, number], gap: number): T[][] {
  const left = new Set(items);
  const out: T[][] = [];
  for (const first of items) {
    if (!left.has(first)) continue;
    left.delete(first);
    const group = [first];
    for (let i = 0; i < group.length; i++) {
      const [x, y] = at(group[i]);
      for (const other of left) {
        const [ox, oy] = at(other);
        if (Math.hypot(ox - x, oy - y) < gap) { group.push(other); left.delete(other); }
      }
    }
    out.push(group);
  }
  return out;
}
