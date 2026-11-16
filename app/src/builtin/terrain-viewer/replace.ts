// Replace Cliff Type, Replace Tiles, Replace Doodads and Replace Units (the World Editor's Advanced menu):
// one type becomes another across the map, or both trade places ("Swap Both"); doodads and units can be
// limited to the selection. The changes themselves, and the small dialog the commands show.

import type { Terrain } from "../../lib/terrain/w3e";
import type { CornerLog } from "../../lib/terrain/cliffs";
import { h } from "../../workbench/dom";
import { keyOf } from "../../lib/keys";
import { forEachStampCell } from "../../lib/terrain/pathing";
import type { RoomShape } from "./occupancy";

export type ReplaceKind = "cliffs" | "tiles" | "doodads" | "units";

/** What a Replace command does: `from` becomes `to` (both swap with `swap`). Ids: ground tiles (cliffs: the
 *  ground tile whose cliff it is, as the map's cliff types follow its ground tiles), else object types. */
export interface ReplaceRequest {
  from: string;
  to: string;
  swap?: boolean;
  /** Doodads and units: only those selected. */
  selectedOnly?: boolean;
  /** Doodads: each replaced one takes a random variation of its new type (else it keeps its own where it can). */
  resetVariations?: boolean;
}

/** A type to choose, with how many there are of it. */
export interface ReplaceChoice { id: string; label: string; count: number }

/** What an open terrain editor offers the Replace commands. */
export interface ReplaceTypes {
  /** The types there are now: tiles and cliff types of the map's lists, placed doodads or units; `selected`, how many
   *  objects of this kind are selected. */
  choices(kind: ReplaceKind): Promise<{ from: ReplaceChoice[]; to: ReplaceChoice[]; selected: number }>;
  /** Picks the new object type in the object browser (doodads, units): null when cancelled. */
  pickType?(kind: "doodads" | "units", from: string): Promise<{ id: string; label: string } | null>;
  /** Does it as one undo step; how many corners or objects changed (none: no undo step). Throws with the reason when refused. */
  run(kind: ReplaceKind, req: ReplaceRequest): Promise<number>;
}

const WORDS: Record<ReplaceKind, { title: string; one: string; many: string }> = {
  cliffs: { title: "Replace Cliff Type", one: "Cliff Type", many: "Cliff Types" },
  tiles: { title: "Replace Tiles", one: "Tile", many: "Tiles" },
  doodads: { title: "Replace Doodads", one: "Doodad Type", many: "Doodad Types" },
  units: { title: "Replace Units", one: "Unit Type", many: "Unit Types" },
};
export const replaceTitle = (kind: ReplaceKind) => WORDS[kind].title;

/** Corners whose `field` (a ground tile or cliff type number) is `from` get `to`, and with `swap` those with `to` get
 *  `from`. Each corner is told to `log` before it changes. The corners changed. (A number past the map's list, such
 *  as the cliff type 15 that flat ground often has, is neither, so it stays.) */
export function replaceCorners(t: Terrain, field: "texture" | "cliffTexture", from: number, to: number, swap: boolean, log: CornerLog): number[] {
  const changed: number[] = [];
  if (from === to) return changed;
  t.corners.forEach((c, i) => {
    const next = c[field] === from ? to : swap && c[field] === to ? from : null;
    if (next === null) return;
    log.touch(t, i);
    c[field] = next;
    changed.push(i);
  });
  return changed;
}

/** For placed objects: old id → new id, both ways with `swap`. */
export function swapsOf(req: ReplaceRequest): Record<string, string> {
  return req.swap && req.from !== req.to ? { [req.from]: req.to, [req.to]: req.from } : { [req.from]: req.to };
}

/** The cells of the 32-unit pathing grid (index y * width + x, rows from the south) that `shape` at (x, y) facing
 *  `angle` (radians) covers. A circle covers each cell it reaches into: in the World Editor a footman (collision 31)
 *  whose middle is 24 from a crate's edge keeps a barrel from becoming that crate, one 40 from it doesn't. */
export function roomCells(t: Terrain, shape: RoomShape, x: number, y: number, angle: number): number[] {
  const w = (t.width - 1) * 4, h = (t.height - 1) * 4, out: number[] = [];
  if (!shape) return out;
  if ("radius" in shape) {
    const gx = (x - t.offsetX) / 32, gy = (y - t.offsetY) / 32, r = shape.radius / 32;
    for (let cy = Math.max(0, Math.floor(gy - r)); cy <= Math.min(h - 1, Math.floor(gy + r)); cy++) {
      for (let cx = Math.max(0, Math.floor(gx - r)); cx <= Math.min(w - 1, Math.floor(gx + r)); cx++) {
        // From the middle to the cell's nearest point.
        const dx = Math.max(cx - gx, 0, gx - cx - 1), dy = Math.max(cy - gy, 0, gy - cy - 1);
        if (dx * dx + dy * dy < r * r) out.push(cy * w + cx);
      }
    }
    return out;
  }
  forEachStampCell(t, w, h, { x, y, angle, width: shape.width, height: shape.height }, (cx, cy, pixel) => {
    if (shape.mask[pixel]) out.push(cy * w + cx);
  });
  return out;
}

/** Replace Doodads' rule for room, as the World Editor has it: a doodad keeps its new type only where that type's
 *  footprint, on its new grid, covers no cell another placed object covers then. `others`: the cells of every object
 *  that isn't being replaced (doodads and destructables with a pathing texture, units, items, buildings; not the
 *  ground: a cliff or water under the new footprint doesn't stop it). `swapped`, in the file's order, each one's cells
 *  before and after. They go one by one: one replaced earlier counts with its new cells, one still to come with its
 *  old ones, its own old cells never. Measured (tests/we-compare/replace-doodad-overlap.json): barrels to crates
 *  beside a tree, crates, a doodad, a footman, an item or a farm stay barrels, beside a pathless doodad or across a
 *  cliff they become crates; of two barrels whose crates would overlap, the one first in the file becomes one.
 *  Whether each may change, in `swapped`'s order. */
export function roomForReplaced(others: Iterable<readonly number[]>, swapped: readonly { before: readonly number[]; after: readonly number[] }[]): boolean[] {
  const taken = new Map<number, number>();
  const add = (cells: readonly number[], by: number) => { for (const c of cells) taken.set(c, (taken.get(c) ?? 0) + by); };
  for (const cells of others) add(cells, 1);
  for (const s of swapped) add(s.before, 1);
  return swapped.map((s) => {
    add(s.before, -1);
    const free = s.after.every((c) => !taken.get(c));
    add(free ? s.after : s.before, 1);
    return free;
  });
}

/** A replaced object's variation: it keeps its own when the new type has it, else (more variations on the old type)
 *  it takes a random one of the new type's (measured on HillsbradCreek, tests/we-compare/replace-doodads-hillsbrad.json:
 *  FTtw's 0 to 9 became LTcr's 0 or 1, 0 and 1 stayed, 2 to 9 split about half and half, not all the last). */
export function variationAfter(old: number, numVar: number, random: () => number = Math.random): number {
  return old < numVar ? old : Math.floor(random() * Math.max(1, numVar));
}

/** The dialog: Old and New type, Swap Both, and for objects Selected Only (and Reset Variations for doodads).
 *  Resolves with the request, or null when cancelled. */
export function askReplace(kind: ReplaceKind, choices: { from: ReplaceChoice[]; to: ReplaceChoice[]; selected: number },
  pickType?: (from: string) => Promise<{ id: string; label: string } | null>): Promise<ReplaceRequest | null> {
  const w = WORDS[kind], objects = kind === "doodads" || kind === "units";
  return new Promise((resolve) => {
    const option = (c: ReplaceChoice) => h("option", { value: c.id }, `${c.label}${c.count ? ` · ${c.count.toLocaleString()}` : ""}`);
    const from = h("select.newmap-input.replace-from", {}, ...choices.from.map(option));
    // Objects: the new type comes from the object browser (any type of the kinds it can become), or one already placed.
    const to = h("select.newmap-input.replace-to", {}, ...choices.to.map(option));
    const browse = objects && pickType ? h("button", { onclick: async (e: Event) => {
      e.preventDefault();
      overlay.hidden = true;
      const p = await pickType(from.value).catch(() => null);
      overlay.hidden = false;
      if (!p) return;
      if (![...to.options].some((o) => o.value === p.id)) to.prepend(h("option", { value: p.id }, p.label));
      to.value = p.id;
    } }, "Choose…") : null;
    const swap = h("input.replace-swap", { type: "checkbox" });
    const selectedOnly = h("input.replace-selected", { type: "checkbox", checked: false, disabled: !choices.selected });
    const resetVariations = h("input.replace-variations", { type: "checkbox" });
    const error = h("div.newmap-error");
    const close = (v: ReplaceRequest | null) => { overlay.remove(); resolve(v); };
    const ok = () => {
      if (!from.value) { error.textContent = `There is no ${w.one.toLowerCase()} to replace.`; return; }
      if (!to.value) { error.textContent = `Choose the new ${w.one.toLowerCase()}.`; return; }
      if (to.value === from.value) { error.textContent = `The old and the new ${w.one.toLowerCase()} are the same.`; return; }
      close({ from: from.value, to: to.value, swap: swap.checked, ...(objects ? { selectedOnly: selectedOnly.checked } : {}), ...(kind === "doodads" ? { resetVariations: resetVariations.checked } : {}) });
    };
    const row = (label: string, ...content: (HTMLElement | string | null)[]) => h("label.newmap-row", {}, h("span.newmap-label", {}, label), ...content);
    const check = (box: HTMLElement, label: string) => h("label.newmap-row.replace-check", {}, box, ` ${label}`);
    const overlay = h("div.picker-overlay.newmap-overlay.replace-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); },
      onkeydown: (e: KeyboardEvent) => {
        if (keyOf(e) === "Escape") close(null);
        if (keyOf(e) === "Enter") ok();
      },
    }, h("div.picker.newmap-dialog.replace-dialog", {},
      h("div.picker-header", {}, h("strong", {}, w.title), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(null) }, "×")),
      row(`Old ${w.one}`, from),
      row(`New ${w.one}`, to, browse),
      check(swap, `Swap Both ${w.many}`),
      objects ? check(selectedOnly, `Selected ${kind === "doodads" ? "Doodads" : "Units"} Only${choices.selected ? ` (${choices.selected})` : ""}`) : null,
      kind === "doodads" ? check(resetVariations, "Reset Variations") : null,
      error,
      h("div.newmap-buttons", {},
        h("button", { onclick: () => close(null) }, "Cancel"),
        h("button.primary", { onclick: ok }, "Replace"))));
    document.body.append(overlay);
    from.focus();
  });
}
