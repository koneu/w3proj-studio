// What the menu bar shows, worked out from the commands: a command says where it belongs, so an
// extension adds to the menus the way it adds a command.

import type { CommandContribution } from "../extensions/api";
import { keyLabel, normalizeKey } from "../lib/keybindings";

/** The World Editor's order. A menu an extension names that isn't here goes before Help. */
const ORDER = ["File", "Edit", "View", "Scenario", "Module", "Tools", "Help"];

export interface MenuEntry { id: string; title: string; shortcut?: string; when?: CommandContribution["when"] }
export interface Menu { name: string; groups: MenuEntry[][] }

/** "ctrl+shift+b" as the World Editor would write it: Ctrl+Shift+B ("ctrl+k ctrl+s": Ctrl+K Ctrl+S). */
export const shortcutText = (keys: string) => keyLabel(normalizeKey(keys) ?? keys);

/** "File:2:1" is the menu File, group 2, first in it. Group and place are optional. */
function place(menu: string) {
  const [name, group, order] = menu.split(":");
  return { name: name.trim(), group: Number(group) || 0, order: Number(order) || 0 };
}

/** Why a command can't run now; undefined when it can. */
export function whyBlocked(when: MenuEntry["when"], now: { project: boolean; editor: boolean; save: boolean; undo: boolean }): string | undefined {
  if (when === "project" && !now.project) return "Open or import a project first.";
  if (when === "editor" && !now.editor) return "Nothing is open.";
  if (when === "save" && !now.save) return "This can't be saved.";
  if (when === "undo" && !now.undo) return "This editor has no undo.";
  return undefined;
}

/** The entry a step away, past those switched off and round the ends; -1 if none can be chosen. */
export function nextEnabled(enabled: readonly boolean[], from: number, step: 1 | -1): number {
  const n = enabled.length;
  let i = from < 0 && step < 0 ? 0 : from;
  for (let tries = 0; tries < n; tries++) {
    i = (i + step + n) % n;
    if (enabled[i]) return i;
  }
  return -1;
}

/** The menu Alt and a letter opens: the first one starting with it. */
export const menuFor = (names: readonly string[], key: string) => names.find((n) => n[0].toLowerCase() === key.toLowerCase());

export function menuTree(commands: readonly CommandContribution[]): Menu[] {
  const menus = new Map<string, Map<number, { order: number; at: number; entry: MenuEntry }[]>>();
  commands.forEach((c, at) => {
    if (!c.menu) return;
    const { name, group, order } = place(c.menu);
    if (!name) return;
    if (!menus.has(name)) menus.set(name, new Map());
    const groups = menus.get(name) as Map<number, { order: number; at: number; entry: MenuEntry }[]>;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)?.push({ order, at, entry: { id: c.id, title: c.title, ...(c.keybinding ? { shortcut: shortcutText(c.keybinding) } : {}), ...(c.when ? { when: c.when } : {}) } });
  });
  const rank = (name: string) => { const i = ORDER.indexOf(name); return i >= 0 ? i : ORDER.length - 1.5; };
  return [...new Set([...ORDER, ...menus.keys()])].filter((n) => menus.has(n)).sort((a, b) => rank(a) - rank(b)).map((name) => ({
    name,
    groups: [...(menus.get(name) as Map<number, { order: number; at: number; entry: MenuEntry }[]>)].sort(([a], [b]) => a - b)
      .map(([, items]) => items.sort((a, b) => a.order - b.order || a.at - b.at).map((i) => i.entry)),
  }));
}
