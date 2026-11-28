// A melee map as a handful of numbers, and where they fall against a set of reference maps: check_melee's
// "comparison". The references are held as numbers only (meleereference.json: per feature the lowest, the usual
// span and the highest over the game's two-player melee maps; scripts/melee-reference.mjs makes it), so a map is
// told where it is unlike them without any of them being shown or named.

export type Features = Record<string, number>;

/** What each feature is, for the answer. */
export const FEATURE_NOTES: Record<string, string> = {
  openGround: "% of the walkable ground more than 400 from anything in the way",
  walkable: "% of the playable map units can walk on",
  narrowGround: "% of the walkable ground that is narrow strips",
  campsPerPlayer: "creep camps for each start (mine guards included)",
  campShelter: "the usual share of the ring round a camp that is walled off (median, 0 to 1)",
  campShelterLowest: "the most exposed camp's share",
  campWays: "ways into a camp, on average",
  campLevel: "a camp's total level (median)",
  campLevelHighest: "the strongest camp's total level",
  nearestCamp: "from a start to its nearest camp, on average",
  nearestExpansion: "from a start to the nearest mine that isn't its own, straight, on average",
  naturalWalk: "the walk from a start to that mine, on average",
  startToStart: "the walk between the two starts",
  mines: "gold mines",
  treesPlayable: "trees in the playable area",
  treesPer100Walkable: "trees for every 100 walkable pathing cells",
};

export interface FeatureRange { min: number; low: number; median: number; high: number; max: number }
export interface Reference { maps: number; features: Record<string, FeatureRange> }

const mid = (sorted: number[], share: number) => {
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * share, a = Math.floor(at), b = Math.ceil(at);
  return sorted[a] + (sorted[b] - sorted[a]) * (at - a);
};
export const median = (values: readonly number[]) => mid([...values].sort((a, b) => a - b), 0.5);
const tidy = (v: number) => Math.round(v * 100) / 100;

/** The reference of a set of maps' features: per feature the lowest, the span most lie in (the middle 80%), the
 *  median and the highest. A feature a map lacks (no camps: no shelter) isn't counted for that map. */
export function referenceOf(maps: readonly Features[]): Reference {
  const keys = [...new Set(maps.flatMap((m) => Object.keys(m)))].sort();
  const features: Record<string, FeatureRange> = {};
  for (const key of keys) {
    const v = maps.map((m) => m[key]).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (v.length) features[key] = { min: tidy(v[0]), low: tidy(mid(v, 0.1)), median: tidy(mid(v, 0.5)), high: tidy(mid(v, 0.9)), max: tidy(v[v.length - 1]) };
  }
  return { maps: maps.length, features };
}

export interface Outlier { feature: string; what: string; value: number; usual: [number, number]; range: [number, number]; verdict: string }

/** Where a map's features fall outside the references: past every one of them, or outside the span most lie in. */
export function compareFeatures(own: Features, ref: Reference): Outlier[] {
  const out: Outlier[] = [];
  for (const [feature, value] of Object.entries(own)) {
    const r = ref.features[feature];
    if (!r || !Number.isFinite(value)) continue;
    const verdict = value < r.min ? `below all ${ref.maps} reference maps` : value > r.max ? `above all ${ref.maps} reference maps`
      : value < r.low ? "lower than nine in ten reference maps" : value > r.high ? "higher than nine in ten reference maps" : null;
    if (verdict) out.push({ feature, what: FEATURE_NOTES[feature] ?? feature, value: tidy(value), usual: [r.low, r.high], range: [r.min, r.max], verdict });
  }
  // What is outside everything first.
  return out.sort((a, b) => Number(/all/.test(b.verdict)) - Number(/all/.test(a.verdict)));
}
