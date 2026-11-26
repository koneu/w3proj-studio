// Which part of a long list to make: only what is in or near the view, between two spacers that
// keep the scroll bar's length. A list of thousands of rows laid out in full stalls every redraw.

/** Lists of at most this many entries are made in full. */
export const WINDOW_ABOVE = 200;

export interface ListWindow {
  /** The entries to make: `from` up to, not including, `to`. */
  from: number;
  to: number;
  /** The height of what is left out before and after them. */
  before: number;
  after: number;
}

/** The entries (by their heights, in order) that reach into the view from `top` over `height`, and `extra` more each way. */
export function listWindow(heights: readonly number[], top: number, height: number, extra: number): ListWindow {
  const total = heights.reduce((n, h) => n + h, 0);
  // A view past the end (the list just got shorter) shows the end.
  const start = Math.max(0, Math.min(top, total - height) - extra), end = Math.min(total, start + height + 2 * extra);
  let from = 0, before = 0;
  while (from < heights.length && before + heights[from] <= start) before += heights[from++];
  let to = from, at = before;
  while (to < heights.length && at < end) at += heights[to++];
  return { from, to, before, after: total - at };
}
