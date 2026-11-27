// The Object Placer's "Recent": the last objects placed, newest first, to take up again with one choice. Kept per
// user (not per project), so it is there after a restart; a custom object of another map isn't offered again.

import type { RandomSpec } from "../../lib/terrain/randomplace";

export interface RecentPlaced {
  kind: string;
  id: string;
  /** As the list shows it (a doodad's or destructable's with its tileset). */
  label: string;
  /** What a random object was set to. */
  random?: RandomSpec;
}

export const RECENT_LIMIT = 5;

const same = (a: RecentPlaced, b: RecentPlaced) => a.kind === b.kind && a.id === b.id && JSON.stringify(a.random ?? null) === JSON.stringify(b.random ?? null);

/** `list` with `placed` at its head, once, and no longer than the limit. */
export function withRecent(list: readonly RecentPlaced[], placed: RecentPlaced): RecentPlaced[] {
  return [placed, ...list.filter((r) => !same(r, placed))].slice(0, RECENT_LIMIT);
}

/** The stored list; what isn't one (nothing yet, damaged) is empty, entries that aren't one are left out. */
export function parseRecent(stored: string | null): RecentPlaced[] {
  try {
    const list: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(list)
      ? list.filter((r): r is RecentPlaced => !!r && typeof r.kind === "string" && typeof r.id === "string" && typeof r.label === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}
