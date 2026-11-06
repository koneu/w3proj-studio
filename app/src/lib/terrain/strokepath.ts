// Brush strokes: the mouse reports far-apart points on a quick drag, so a stroke is stamped along
// the line between them, or it would come out as dots.

/** How often a height brush acts while held: its strength is what it adds per tick at the centre. */
export const HEIGHT_TICK = 40;
/** A stall (a slow frame) doesn't count for more than this. */
const LONGEST_STEP = 200;

/** Height a brush adds over `ms`, spread evenly along the points it passed, so speed decides how
 *  far the height goes and not where it lands: a quick drag rises less, without gaps. */
export const heightPerPoint = (strength: number, ms: number, points: number) => (strength * Math.min(ms, LONGEST_STEP)) / HEIGHT_TICK / Math.max(1, points);

/** A height brush at work. The mouse only says where it is; the clock does the stamping, from where
 *  it was to the newest place. A second source of stamps would land at old places while the app is
 *  busy, which is what a quick drag's bumps were. */
export class HeightStroke {
  private to: readonly [number, number];

  constructor(private at: readonly [number, number], private last: number, private spacing: number) {
    this.to = at;
  }

  moveTo(place: readonly [number, number]) { this.to = place; }

  /** The stamps since the last tick. */
  tick(now: number, strength: number) {
    const points = strokePoints(this.at, this.to, this.spacing);
    const amount = heightPerPoint(strength, now - this.last, points.length);
    this.at = this.to;
    this.last = now;
    return points.map(([x, y]) => ({ x, y, amount }));
  }
}

/** Points after `from` up to and including `to`, at most `spacing` apart. */
export function strokePoints(from: readonly [number, number], to: readonly [number, number], spacing: number): [number, number][] {
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / spacing));
  return Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * (i + 1)) / n, from[1] + ((to[1] - from[1]) * (i + 1)) / n]);
}
