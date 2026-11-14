// Which lines of a GUI trigger are selected: one, or several of one list (Shift/Ctrl-click, Select All). Pure, so the
// rules are tested without the view.

import type { Eca, TriggerItem } from "../../lib/triggers/wtg";

export type Located = { list: Eca[]; index: number; eca: Eca };
export type Chosen = Located & { path: number[] };
/** A multi-selection held: the paths and the line objects there (an undo or redo that replaced them ends it). */
export type Held = { path: number[]; eca: Eca }[];

/** The list holding the ECA at `path` in `t`, and its index there. */
export function locateIn(t: TriggerItem, path: number[]): Located | null {
  let list = t.ecas;
  for (let d = 0; d < path.length; d++) {
    const eca = list[path[d]];
    if (!eca) return null;
    if (d === path.length - 1) return { list, index: path[d], eca };
    list = eca.children;
  }
  return null;
}

/** The lines held at `paths` in `t`, as a multi-selection; none when fewer than two are there. */
export function holdOf(t: TriggerItem, paths: number[][]): Held | null {
  const all = paths.flatMap((path) => { const at = locateIn(t, path); return at ? [{ path, eca: at.eca }] : []; });
  return all.length > 1 ? all : null;
}

/** The selected lines in list order: the one at `primary`, or the several of `held` while each is still where and what it
 *  was (an undo or redo may have put others there) and `primary` is one of them. */
export function chosenFrom(t: TriggerItem, primary: number[] | null, held: Held | undefined): Chosen[] {
  if (!primary) return [];
  const here = primary.join();
  const intact = !!held && held.length > 1 && held.some((m) => m.path.join() === here) && held.every((m) => locateIn(t, m.path)?.eca === m.eca);
  const out: Chosen[] = [];
  for (const path of intact ? held!.map((m) => m.path) : [primary]) { const at = locateIn(t, path); if (at) out.push({ path, ...at }); }
  return out.sort((a, b) => a.index - b.index);
}

/** Whether two lines are in one list and of one kind (top level) or branch: only such lines are selected together, so one
 *  paste puts them back as they were. */
export function sameSet(t: TriggerItem, a: number[], b: number[]): boolean {
  if (a.length !== b.length || a.slice(0, -1).join() !== b.slice(0, -1).join()) return false;
  const x = locateIn(t, a), y = locateIn(t, b);
  if (!x || !y) return false;
  return a.length === 1 ? x.eca.kind === y.eca.kind : (x.eca.group ?? 0) === (y.eca.group ?? 0);
}

/** The paths of the lines in the set of `path` (itself included). */
export function setOf(t: TriggerItem, path: number[]): number[][] {
  const at = locateIn(t, path);
  if (!at) return [];
  return at.list.flatMap((_, i) => { const p = [...path.slice(0, -1), i]; return sameSet(t, path, p) ? [p] : []; });
}

/** What a click on the line at `path` selects, `now` being selected with `anchor` the lead: with Ctrl the line is taken in
 *  or out, with Shift the lines of its set between the anchor and it. Null: select that line alone (a plain click, or one
 *  that doesn't fit the selection). Else the paths and the lead. */
export function clickSelection(t: TriggerItem, now: number[][], anchor: number[] | null, path: number[], how: { ctrl: boolean; shift: boolean }): { paths: number[][]; lead: number[] } | null {
  if (!(how.ctrl || how.shift) || !anchor || !sameSet(t, anchor, path)) return null;
  const key = (p: number[]) => p.join();
  const at = (p: number[]) => p[p.length - 1];
  let paths: number[][];
  if (how.shift) {
    const lo = Math.min(at(anchor), at(path)), hi = Math.max(at(anchor), at(path));
    paths = setOf(t, path).filter((p) => at(p) >= lo && at(p) <= hi);
  } else paths = now.some((p) => key(p) === key(path)) ? now.filter((p) => key(p) !== key(path)) : [...now, path];
  if (!paths.length) return null;
  // The clicked line leads (the one Add and Paste go after) unless it was just taken out.
  return { paths, lead: paths.some((p) => key(p) === key(path)) ? path : paths[paths.length - 1] };
}
