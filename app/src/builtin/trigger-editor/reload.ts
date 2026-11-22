// The Trigger Editor's reload with unsaved edits: the trigger folders (map/triggers/) changed outside the app (git
// checkout, pull, another editor) while the editor has changes of its own. Item by item, against the state last read
// or saved (`base`): what the editor didn't change takes the files' version (added, changed or removed there); what it
// changed keeps the editor's version, and is a conflict when the files changed it too. Items are known by their file
// (the backend's `files`), variables and their nodes by name, the custom script header as one; items the editor added
// have no file yet and are put back where they were, after their sibling or in their folder.

import { allocItemId, textTriggers, type Item, type TriggerFile, type TriggerItem, type Variable } from "../../lib/triggers/wtg";
import { moveItem, subtree, treeStructure } from "./tree";

/** One state of the tree: the triggers, their texts (textTriggers order), the header, and each item's file (null: none,
 *  or not saved yet). */
export interface ReloadSide { file: TriggerFile; texts: (string | null)[]; header: string | null; files: (string | null)[] }

/** The result: the merged tree, and the keys of the items the files changed under an edit kept here. */
export interface Merged { file: TriggerFile; texts: (string | null)[]; header: string | null; conflicts: string[]; kept: number }

const isFolder = (it: Item) => it.type === 2 || it.type === 4;

/** An item's id with its kind, as the backend's `stored` names them: "f" folders and the map item, "v" variables, "t" the rest. */
export const idKey = (it: { type: number; id: number }) => `${it.type === 1 || isFolder(it as Item) ? "f" : it.type === 64 ? "v" : "t"}${it.id}`;

/** The key an item is known by across reads: its file, "$name" for a variable node, "#root" for the map item. */
function keysOf(side: ReloadSide): (string | null)[] {
  return side.file.items.map((it, i) => side.files[i] ?? (it.type === 64 ? `$${it.name}` : it.type === 1 ? "#root" : null));
}

interface Entry { item: Item; text: string | null; parent: string | null }

/** Per key: the item, its text and its folder's key (null: the root). */
function entries(side: ReloadSide): Map<string, Entry> {
  const keys = keysOf(side), at = new Map(side.file.items.map((it, i) => [it, keys[i]] as [Item, string | null]));
  const s = treeStructure(side.file);
  const texts = new Map(textTriggers(side.file).map((t, i) => [t as Item, side.texts[i] ?? null] as [Item, string | null]));
  const out = new Map<string, Entry>();
  side.file.items.forEach((it, i) => {
    const k = keys[i];
    if (!k) return;
    const p = s.parentOf.get(it) ?? null;
    out.set(k, { item: it, text: texts.get(it) ?? null, parent: p ? at.get(p) ?? null : null });
  });
  return out;
}

/** What an item is, apart from its id, its folder's id and whether it's open in the tree. */
function content(e: Entry): string {
  const { id: _id, parent: _parent, ...rest } = e.item as Item & { expanded?: number };
  if ("expanded" in rest) delete (rest as { expanded?: number }).expanded;
  return JSON.stringify([rest, e.text, e.parent]);
}

const varContent = (v: Variable) => JSON.stringify({ ...v, id: 0, parent: 0 });

/** See the top. `mine`: the editor's state now (its items' files from what it read or saved last). */
export function mergeReload(base: ReloadSide, mine: ReloadSide, theirs: ReloadSide): Merged {
  const file = structuredClone(theirs.file);
  const conflicts: string[] = [];
  let kept = 0;
  const b = entries(base), m = entries(mine);
  const theirKeys = keysOf(theirs);
  // `file` is a copy of theirs: its triggers with texts are in the same order.
  const text = new Map<Item, string | null>();
  textTriggers(file).forEach((x, i) => text.set(x, theirs.texts[i] ?? null));
  const byKey = new Map<string, Item>();
  file.items.forEach((it, i) => { const k = theirKeys[i]; if (k) byKey.set(k, it); });
  const t = entries({ ...theirs, file });
  const gone = new Set<Item>();
  const moves: { it: Item; parent: string | null }[] = [];
  // 1. Items the files have.
  for (const [k, it] of byKey) {
    const was = b.get(k), now = m.get(k), there = t.get(k)!;
    if (!was || it.type === 1) continue;
    if (!now) {
      // Removed here: gone, unless the files changed it meanwhile (then theirs stays, flagged).
      if (content(there) === content(was)) gone.add(it); else conflicts.push(k);
      continue;
    }
    if (content(now) === content(was)) continue;
    if (content(there) !== content(was)) conflicts.push(k);
    kept++;
    const keepId = it.id, keepParent = it.parent;
    Object.assign(it, structuredClone(now.item), { id: keepId, parent: keepParent });
    if ("ecas" in it && (it.type === 8 || it.type === 32)) text.set(it, now.text);
    if (now.parent !== was.parent) moves.push({ it, parent: now.parent });
  }
  // 2. Removed items go; what is left inside them moves up to the nearest folder that stays.
  if (gone.size) {
    const s = treeStructure(file);
    const root = file.items.find((i) => i.type === 1);
    for (const it of file.items) {
      if (gone.has(it)) continue;
      let p = s.parentOf.get(it) ?? null;
      if (!p || !gone.has(p)) continue;
      while (p && gone.has(p)) p = s.parentOf.get(p) ?? null;
      it.parent = p ? p.id : root ? root.id : -1;
    }
    file.items = file.items.filter((i) => !gone.has(i));
  }
  // 3. Variables, by name.
  const vb = new Map(base.file.variables.map((v) => [v.name, v])), vm = new Map(mine.file.variables.map((v) => [v.name, v]));
  for (const [name, v] of vm) {
    const was = vb.get(name), at = file.variables.findIndex((x) => x.name === name);
    if (!was) {
      if (at < 0) file.variables.push({ ...structuredClone(v), id: file.reforged ? allocItemId(file, 64) : file.variables.length });
      else conflicts.push(`$${name}`);
      continue;
    }
    if (varContent(v) === varContent(was)) continue;
    if (at < 0) { conflicts.push(`$${name}`); file.variables.push({ ...structuredClone(v), id: file.reforged ? allocItemId(file, 64) : file.variables.length }); continue; }
    if (varContent(file.variables[at]) !== varContent(was)) conflicts.push(`$${name}`);
    file.variables[at] = { ...structuredClone(v), id: file.variables[at].id, parent: file.variables[at].parent };
  }
  for (const [name, was] of vb) {
    if (vm.has(name)) continue;
    const at = file.variables.findIndex((x) => x.name === name);
    if (at < 0) continue;
    if (varContent(file.variables[at]) === varContent(was)) {
      file.variables.splice(at, 1);
      file.items = file.items.filter((i) => !(i.type === 64 && i.name === name));
    } else conflicts.push(`$${name}`);
  }
  if (!file.reforged) file.variables.forEach((v, i) => { v.id = i; });
  // 4. Items added here (no file yet), where they were: after their sibling, else first in their folder.
  const ms = treeStructure(mine.file), mineKeys = keysOf(mine);
  const counterpart = new Map<Item, Item>();
  const resultOf = (x: Item | null): Item | null => {
    if (!x) return null;
    const k = mineKeys[mine.file.items.indexOf(x)];
    const there = k ? byKey.get(k) : undefined;
    return (there && file.items.includes(there) ? there : counterpart.get(x)) ?? null;
  };
  for (const [i, src] of mine.file.items.entries()) {
    // New here: no key the last read had (a new item has no file; a new variable node's "$name" wasn't there).
    const k = mineKeys[i];
    if ((k && (b.has(k) || byKey.has(k))) || src.type === 1) continue;
    if (src.type === 64 && file.items.some((x) => x.type === 64 && x.name === src.name)) continue;
    const it = structuredClone(src);
    const folder = resultOf(ms.parentOf.get(src) ?? null);
    const root = file.items.find((x) => x.type === 1);
    if (it.type === 64) {
      const v = file.variables.find((x) => x.name === it.name);
      if (!v) continue;
      it.id = v.id;
    } else it.id = allocItemId(file, it.type);
    it.parent = folder ? folder.id : root ? root.id : -1;
    if (it.type === 64) { const v = file.variables.find((x) => x.name === it.name)!; v.parent = it.parent; }
    const siblings = ms.children.get(ms.parentOf.get(src) ?? null) ?? [];
    const before = siblings.slice(0, siblings.indexOf(src)).reverse().map(resultOf).find((x): x is Item => !!x);
    let index: number;
    if (before) index = file.items.indexOf(subtree(file, before).at(-1)!) + 1;
    else if (folder) index = file.items.indexOf(folder) + 1;
    else index = root ? 1 : 0;
    file.items.splice(index, 0, it);
    counterpart.set(src, it);
    if ("ecas" in it && (it.type === 8 || it.type === 32)) text.set(it, mine.texts[textTriggers(mine.file).indexOf(src as TriggerItem)] ?? null);
    kept++;
  }
  // 5. Items moved here to another folder that is there.
  for (const mv of moves) {
    if (!file.items.includes(mv.it)) continue;
    const target = mv.parent ? byKey.get(mv.parent) : undefined;
    if (target && file.items.includes(target) && isFolder(target) && !subtree(file, mv.it).includes(target)) moveItem(file, mv.it, target, "into");
  }
  // 6. The header.
  let header = theirs.header;
  if (mine.header !== base.header) {
    if (theirs.header !== base.header) conflicts.push("#header");
    header = mine.header;
    kept++;
  }
  return { file, texts: textTriggers(file).map((x) => text.get(x) ?? null), header, conflicts, kept };
}
