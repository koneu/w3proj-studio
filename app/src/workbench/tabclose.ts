export type CloseMode = "others" | "right" | "all";

/** The tabs a "Close Others / to the Right / All" on `from` closes, in tab order (`from` itself is never one of
 *  them, except with "all"). Empty when `from` isn't among them. */
export function tabsToClose<T>(tabs: readonly T[], from: T, mode: CloseMode): T[] {
  const i = tabs.indexOf(from);
  if (i < 0) return [];
  if (mode === "all") return [...tabs];
  if (mode === "right") return tabs.slice(i + 1);
  return tabs.filter((t) => t !== from);
}

/** Closes the tabs one after the other through `close` (false: cancelled, e.g. at a Save question), and stops
 *  at the first one that stays. True when all are gone. */
export async function closeInOrder<T>(list: readonly T[], close: (t: T) => Promise<boolean>): Promise<boolean> {
  for (const t of list) if (!(await close(t))) return false;
  return true;
}
