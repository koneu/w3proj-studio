// melee_motif: how a kind of place on a melee map is usually built, as numbers: a camp pocket, a natural (an
// expansion's mine with its guards) and a shop clearing, measured over the game's two-player melee maps. Only the
// spans are kept (meleemotifs.json, made by scripts/melee-reference.mjs): no map, no patch of one, no place.

export type MotifKind = "camp pocket" | "natural" | "shop clearing";
export const MOTIF_KINDS: readonly MotifKind[] = ["camp pocket", "natural", "shop clearing"];

/** One place as measured: the share of the ring round it that is walled off, the gaps in the ring, the widest gap in
 *  degrees, and how far the nearest wall is from the open middle. */
export interface Measured { closed: number; ways: number; widest: number; room: number }
export type MeasuredPlaces = Record<MotifKind, Measured[]>;

export interface Span { low: number; usual: number; high: number }
export interface Motif { places: number; ringClosed: Span; waysIn: Span; widestGap: Span; roomAtMiddle: Span }
export type Motifs = Record<MotifKind, Motif>;

const span = (values: number[], tidy: (v: number) => number): Span => {
  const v = [...values].sort((a, b) => a - b), at = (share: number) => tidy(v[Math.round((v.length - 1) * share)]);
  return { low: at(0.1), usual: at(0.5), high: at(0.9) };
};

/** What a kind's places usually measure: for each number the span the middle eight in ten lie in, and the median. */
export function motifOf(places: readonly Measured[]): Motif {
  if (!places.length) throw new Error("no places to take a motif from");
  const two = (v: number) => Math.round(v * 100) / 100, whole = (v: number) => Math.round(v);
  return {
    places: places.length,
    ringClosed: span(places.map((p) => p.closed), two),
    waysIn: span(places.map((p) => p.ways), whole),
    widestGap: span(places.map((p) => p.widest), whole),
    roomAtMiddle: span(places.map((p) => p.room), whole),
  };
}

export const MOTIF_NOTES = {
  ringClosed: "the share of the ring 256 to 640 round the place that is walled off by trees, cliffs or water (0 to 1)",
  waysIn: "gaps in that ring at least 30° wide",
  widestGap: "the widest gap, in degrees of the ring (a quarter of it is 90): the side the place is entered from",
  roomAtMiddle: "how far the nearest wall is from the open ground at the middle, in world units",
};
