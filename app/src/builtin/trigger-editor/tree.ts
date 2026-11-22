// Moving items in the trigger tree (drag and drop). Items are listed in file
// order with a parent category; a category moves together with everything in
// it, so parents always come before their contents (as the World Editor
// writes them). Triggers, comments and variables live in categories;
// categories nest only in Reforged files.

import type { Item, TriggerFile, Variable } from "../../lib/triggers/wtg";

export type DropMode = "into" | "before";

const isCategory = (it: Item) => it.type === 4 || it.type === 2;

/** The category (or map root) with this id (ids of other item types may repeat it in older files). */
function container(file: TriggerFile, id: number): Item | undefined {
  return file.items.find((i) => i.id === id && (isCategory(i) || i.type === 1));
}

/** Whether the only unsaved change is a folded or unfolded category (view state the file keeps): the editor's state is
 *  the one last saved, and categories were toggled since. A real edit, or a name typed and not committed, says no. */
export function onlyFoldsUnsaved(s: { state: number; savedAt: number; toggles: number; savedToggles: number; pendingName: boolean }): boolean {
  return s.state === s.savedAt && s.toggles !== s.savedToggles && !s.pendingName;
}

/** The categories the file has closed (each category's `expanded`): how the tree opens. */
export function collapsedOf(file: TriggerFile): Set<number> {
  const out = new Set<number>();
  for (const it of file.items) if (isCategory(it) && "expanded" in it && !it.expanded) out.add(it.id);
  return out;
}

/** The tree's open and closed categories written into `file` (changed in place), as the World Editor saves them.
 *  Only a flag that disagrees with the tree changes, so a file whose tree wasn't toggled keeps its bytes (an
 *  `expanded` other than 0 or 1 too). Classic files don't store it. */
export function applyExpanded(file: TriggerFile, collapsed: ReadonlySet<number>): void {
  if (!file.reforged) return;
  for (const it of file.items) {
    if (!isCategory(it) || !("expanded" in it)) continue;
    if (collapsed.has(it.id)) { if (it.expanded) it.expanded = 0; }
    else if (!it.expanded) it.expanded = 1;
  }
}

/** The tree's structure, from the items' order: each item's folder (null: the map root) and each folder's contents
 *  (`children.get(null)`: the root's), in file order. A Reforged file lists a folder before what is in it (a preorder),
 *  so an item's folder is the nearest open one with its parent id: World Editor maps have categories that share an id,
 *  and a lookup by id alone would mix their contents. A Classic file lists its categories first and gives each trigger
 *  its category's index (the first category with that id, as the file is read). */
export interface TreeStructure { parentOf: Map<Item, Item | null>; children: Map<Item | null, Item[]> }

export function treeStructure(file: TriggerFile): TreeStructure {
  const parentOf = new Map<Item, Item | null>(), children = new Map<Item | null, Item[]>([[null, []]]);
  const put = (it: Item, parent: Item | null) => {
    parentOf.set(it, parent);
    children.get(parent)?.push(it) ?? children.set(parent, [it]);
    if (isCategory(it)) children.set(it, children.get(it) ?? []);
  };
  if (file.reforged) {
    const open: Item[] = [];
    for (const it of file.items) {
      if (it.type === 1) continue;
      while (open.length && open[open.length - 1].id !== it.parent) open.pop();
      put(it, open[open.length - 1] ?? null);
      if (isCategory(it)) open.push(it);
    }
  } else {
    const first = new Map<number, Item>();
    for (const it of file.items) if (isCategory(it) && !first.has(it.id)) first.set(it.id, it);
    for (const it of file.items) {
      if (it.type === 1) continue;
      put(it, isCategory(it) ? null : first.get(it.parent) ?? null);
    }
  }
  return { parentOf, children };
}

/** An item and everything inside it, in file order (by the tree's structure: treeStructure). */
export function subtree(file: TriggerFile, it: Item, structure = treeStructure(file)): Item[] {
  if (!isCategory(it)) return [it];
  const inside = new Set<Item>();
  const visit = (x: Item) => { inside.add(x); for (const c of structure.children.get(x) ?? []) visit(c); };
  visit(it);
  return file.items.filter((x) => inside.has(x));
}

/** The contents of a folder (null: the map root), by the tree's structure. */
export function childrenOf(file: TriggerFile, folder: Item | null, structure = treeStructure(file)): Item[] {
  return structure.children.get(folder?.type === 1 ? null : folder) ?? [];
}

/** Where `drag` goes when dropped on `target` (`upper`: on its upper third), or null if it can't. */
export function dropMode(file: TriggerFile, drag: Item, target: Item, upper: boolean): DropMode | null {
  if (drag.type === 1 || target.type === 1 || subtree(file, drag).includes(target)) return null;
  if (isCategory(drag)) {
    if (isCategory(target) && file.reforged && !upper) return "into";
    return file.reforged || isCategory(target) ? "before" : null;
  }
  if (isCategory(target)) return "into";
  const parent = container(file, target.parent);
  return parent && parent.type !== 1 ? "before" : null;
}

/** Moves `drag` (with its contents) into `target` (at its end) or before it. */
export function moveItem(file: TriggerFile, drag: Item, target: Item, mode: DropMode): void {
  const block = subtree(file, drag);
  const items = file.items.filter((i) => !block.includes(i));
  let index: number;
  if (mode === "into") {
    drag.parent = target.id;
    const inside = subtree(file, target).filter((i) => !block.includes(i));
    index = items.indexOf(inside[inside.length - 1]) + 1;
  } else {
    drag.parent = target.parent;
    index = items.indexOf(target);
  }
  if (drag.type === 64) for (const v of file.variables) if (v.id === drag.id) v.parent = drag.parent;
  items.splice(index, 0, ...block);
  file.items = items;
}

/** Inserts copies of `clip.items` (a block: an item and its contents) at `at`, with new ids
 *  from `allocId`; taken names get " Copy" (triggers, categories) or "Copy" (variables, whose
 *  names must stay valid and unique). Returns the new items in order. */
export function pasteBlock(file: TriggerFile, clip: { items: Item[]; variables: Variable[] }, at: { parent: number; index: number },
  allocId: (type: number) => number): Item[] {
  const names = new Set(file.items.filter((i) => i.type !== 64).map((i) => i.name));
  const free = (name: string) => {
    if (!names.has(name)) return name;
    for (let n = 1; ; n++) { const c = `${name} Copy${n > 1 ? ` ${n}` : ""}`; if (!names.has(c)) return c; }
  };
  const varNames = new Set(file.variables.map((v) => v.name));
  const freeVar = (name: string) => {
    if (!varNames.has(name)) return name;
    for (let n = 1; ; n++) { const c = `${name}Copy${n > 1 ? n : ""}`; if (!varNames.has(c)) return c; }
  };
  const ids = new Map<number, number>();
  return clip.items.map((src, k) => {
    const it = structuredClone(src);
    const id = allocId(it.type);
    if (isCategory(it)) ids.set(src.id, id);
    it.id = id;
    it.parent = k === 0 ? at.parent : ids.get(src.parent) ?? at.parent;
    if (it.type === 64) {
      const v = structuredClone(clip.variables.find((x) => x.id === src.id)!);
      it.name = v.name = freeVar(v.name);
      varNames.add(v.name);
      v.id = id;
      v.parent = it.parent;
      file.variables.push(v);
    } else {
      it.name = free(it.name);
      names.add(it.name);
    }
    // One by one: older files number new items from those already there.
    file.items.splice(at.index + k, 0, it);
    return it;
  });
}
