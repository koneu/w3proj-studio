// What the menu bar shows, worked out from the commands: a command says where it belongs, so an
// extension adds to the menus the way it adds a command.

import type { CommandContribution } from "../extensions/api";

/** The World Editor's order. A menu an extension names that isn't here goes before Help. */
const ORDER = ["File", "Edit", "View", "Scenario", "Module", "Tools", "Help"];

export interface MenuEntry { id: string; title: string; shortcut?: string }
export interface Menu { name: string; groups: MenuEntry[][] }

/** "ctrl+shift+b" as the World Editor would write it: Ctrl+Shift+B. */
export const shortcutText = (keys: string) => keys.split("+").map((k) => (k.length === 1 || /^f\d+$/i.test(k) ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join("+");

/** "File:2:1" is the menu File, group 2, first in it. Group and place are optional. */
function place(menu: string) {
  const [name, group, order] = menu.split(":");
  return { name: name.trim(), group: Number(group) || 0, order: Number(order) || 0 };
}

export function menuTree(commands: readonly CommandContribution[]): Menu[] {
  const menus = new Map<string, Map<number, { order: number; at: number; entry: MenuEntry }[]>>();
  commands.forEach((c, at) => {
    if (!c.menu) return;
    const { name, group, order } = place(c.menu);
    if (!name) return;
    if (!menus.has(name)) menus.set(name, new Map());
    const groups = menus.get(name) as Map<number, { order: number; at: number; entry: MenuEntry }[]>;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)?.push({ order, at, entry: { id: c.id, title: c.title, ...(c.keybinding ? { shortcut: shortcutText(c.keybinding) } : {}) } });
  });
  const rank = (name: string) => { const i = ORDER.indexOf(name); return i >= 0 ? i : ORDER.length - 1.5; };
  return [...new Set([...ORDER, ...menus.keys()])].filter((n) => menus.has(n)).sort((a, b) => rank(a) - rank(b)).map((name) => ({
    name,
    groups: [...(menus.get(name) as Map<number, { order: number; at: number; entry: MenuEntry }[]>)].sort(([a], [b]) => a - b)
      .map(([, items]) => items.sort((a, b) => a.order - b.order || a.at - b.at).map((i) => i.entry)),
  }));
}
