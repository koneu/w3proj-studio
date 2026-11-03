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

/** An item and everything inside it, in file order. */
export function subtree(file: TriggerFile, it: Item): Item[] {
  if (!isCategory(it)) return [it];
  const ids = new Set([it.id]), inside = new Set<Item>([it]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of file.items) {
      if (inside.has(x) || x.type === 1 || !ids.has(x.parent)) continue;
      inside.add(x);
      grew = true;
      if (isCategory(x)) ids.add(x.id);
    }
  }
  return file.items.filter((x) => inside.has(x));
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
