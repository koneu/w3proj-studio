// The World Editor's Edit menu items for a palette's object list (the Region Palette's regions, the Camera Palette's
// cameras), in the order the map keeps them: Select Next in List (Ctrl+Tab), Select Previous in List
// (Ctrl+Shift+Tab), Move Up in List (Ctrl+Page Up) and Move Down in List (Ctrl+Page Down). Greyed out there with
// nothing in the list (we-drive, TwistedMeadows, Edit menu with the Region Palette open, 2026-11-09).

export type ListCommand = "next" | "previous" | "up" | "down";

/** The list command of a key, or null: Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Page Up, Ctrl+Page Down. */
export function listKey(e: { key: string; ctrlKey: boolean; metaKey?: boolean; altKey: boolean; shiftKey: boolean }): ListCommand | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "Tab") return e.shiftKey ? "previous" : "next";
  if (e.shiftKey) return null;
  if (e.key === "PageUp") return "up";
  if (e.key === "PageDown") return "down";
  return null;
}

/** The item Select Next / Previous selects: after (before) `selected`, round past the end; the first (last) with nothing
 *  selected; null for an empty list. */
export function stepInList<T>(list: readonly T[], selected: T | null, dir: 1 | -1): T | null {
  if (!list.length) return null;
  const at = selected === null ? -1 : list.indexOf(selected);
  if (at < 0) return dir > 0 ? list[0] : list[list.length - 1];
  return list[(at + dir + list.length) % list.length];
}

/** The list with `item` one place earlier (dir -1, Move Up) or later; null when it can't move (at that end, or not in
 *  the list). */
export function moveInList<T>(list: readonly T[], item: T, dir: 1 | -1): T[] | null {
  const at = list.indexOf(item), to = at + dir;
  if (at < 0 || to < 0 || to >= list.length) return null;
  const out = [...list];
  [out[at], out[to]] = [out[to], out[at]];
  return out;
}
