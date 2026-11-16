// Creep camps as the World Editor groups them. Measured: pairs up to 828 apart make one camp, 832 and more two
// (CreepCampPathingCellDistance = 26 cells of 32 = 832). Not transitive: a creep joins a camp by its distance to
// the camp's icon creep, not to any member. Used by the melee check, the Item Drops overview and the camp count.
// Diagonals measured too (branch camp-icon-we): the distance is the straight one (588 on both axes, 831.6, joins; 589,
// 832.97, doesn't; 831 x 40 joins, 831 x 45 doesn't), and the icon sits on the first creep of the camp in the
// order of the map's units (chains of three in every order of 400 apart; a chain looking like "middle creep" was
// its end creep taken into a neighbouring camp).

/** Creeps closer than this to a camp's icon creep belong to the camp. */
export const SAME_CAMP = 832;

/** The items in camps, in the order they were given (a camp's first member is its icon creep). */
export function campGroups<T>(items: readonly T[], at: (item: T) => readonly [number, number]): T[][] {
  const out: T[][] = [];
  for (const item of items) {
    const [x, y] = at(item);
    const home = out.find((g) => { const [gx, gy] = at(g[0]); return Math.hypot(x - gx, y - gy) < SAME_CAMP; });
    if (home) home.push(item); else out.push([item]);
  }
  return out;
}
