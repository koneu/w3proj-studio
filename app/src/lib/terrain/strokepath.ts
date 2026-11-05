// Brush strokes: the mouse reports far-apart points on a quick drag, so a stroke is stamped along
// the line between them, or it would come out as dots.

/** Points after `from` up to and including `to`, at most `spacing` apart. */
export function strokePoints(from: readonly [number, number], to: readonly [number, number], spacing: number): [number, number][] {
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / spacing));
  return Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * (i + 1)) / n, from[1] + ((to[1] - from[1]) * (i + 1)) / n]);
}
