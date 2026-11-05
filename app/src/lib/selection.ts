// Selecting rows of a list with the mouse, as everywhere else.

/** The selection after a click on `clicked` in a list shown as `order` (Ctrl toggles, Shift
 *  takes the range from the anchor, a plain click selects one). */
export function clickSelection(order: string[], selected: ReadonlySet<string>, anchor: string | null, clicked: string,
  mods: { ctrl: boolean; shift: boolean }): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor !== null && order.includes(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(clicked)].sort((x, y) => x - y);
    return { selected: new Set([...(mods.ctrl ? selected : []), ...order.slice(a, b + 1)]), anchor };
  }
  if (mods.ctrl) {
    const next = new Set(selected);
    if (!next.delete(clicked)) next.add(clicked);
    return { selected: next, anchor: clicked };
  }
  return { selected: new Set([clicked]), anchor: clicked };
}
