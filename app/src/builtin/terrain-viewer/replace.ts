// Replace Cliff Type, Replace Tiles, Replace Doodads and Replace Units (the World Editor's Advanced menu):
// one type becomes another across the map, or both trade places ("Swap Both"); doodads and units can be
// limited to the selection. The changes themselves, and the small dialog the commands show.

import type { Terrain } from "../../lib/terrain/w3e";
import type { CornerLog } from "../../lib/terrain/cliffs";
import { h } from "../../workbench/dom";

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
        if (e.key === "Escape") close(null);
        if (e.key === "Enter") ok();
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
