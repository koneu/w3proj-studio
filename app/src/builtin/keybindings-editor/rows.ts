// The Keyboard Shortcuts editor's rows, without the page: one per key in effect, and one for each command without a
// key; what a search keeps. The editor passes w3.keybindings' items, the tests made-up ones.

import type { KeybindingInfo } from "../../extensions/api";

export interface Item { command: string; title: string; category?: string; extensionId?: string; bindings: KeybindingInfo[]; userTouched: boolean }
export interface Row { item: Item; binding: KeybindingInfo | null }

/** A search: words that must all be found in a row's command, title, category, key (as written and as read), when or
 *  source; `@source:user` / `@source:default` / `@source:none` keep those; `@key:ctrl+r` the rows of one key exactly;
 *  `@command:id` one command. */
export interface Query { words: string[]; source?: "user" | "default" | "none"; key?: string; command?: string }

export function parseQuery(text: string, normalize: (key: string) => string | null): Query {
  const q: Query = { words: [] };
  for (const part of text.trim().split(/\s+/).filter(Boolean)) {
    const m = /^@(source|key|command):(.+)$/i.exec(part);
    if (m && m[1].toLowerCase() === "source" && ["user", "default", "none"].includes(m[2].toLowerCase())) q.source = m[2].toLowerCase() as Query["source"];
    else if (m && m[1].toLowerCase() === "key") q.key = normalize(m[2].replace(/_/g, " ")) ?? m[2].toLowerCase();
    else if (m && m[1].toLowerCase() === "command") q.command = m[2];
    else q.words.push(part.toLowerCase());
  }
  return q;
}

/** The rows a search keeps: commands with keys first, then by category and title; a command's keys in their order. */
export function rowsOf(items: readonly Item[], q: Query, label: (key: string) => string): Row[] {
  const rows: Row[] = [];
  for (const item of items) for (const binding of item.bindings.length ? item.bindings : [null]) rows.push({ item, binding });
  const kept = rows.filter(({ item, binding }) => {
    if (q.command && item.command !== q.command) return false;
    if (q.key && binding?.key !== q.key) return false;
    if (q.source && (binding?.source ?? "none") !== q.source) return false;
    if (!q.words.length) return true;
    const text = [item.command, item.title, item.category ?? "", item.extensionId ?? "", binding ? `${binding.key} ${label(binding.key)} ${binding.when ?? ""} ${binding.source}` : ""].join(" ").toLowerCase();
    return q.words.every((w) => text.includes(w));
  });
  const name = (i: Item) => `${i.category ? `${i.category}: ` : ""}${i.title}`;
  return kept.map((r, at) => ({ r, at })).sort((a, b) => Number(!a.r.binding) - Number(!b.r.binding) || name(a.r.item).localeCompare(name(b.r.item)) || a.at - b.at).map((x) => x.r);
}
