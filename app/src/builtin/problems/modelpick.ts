// The model picker of the "Replace with a game model…" fix: a searchable list of the game's models
// beside two live previews, the type's current (Reforged) model and the highlighted candidate. The
// list is of one graphics mode at a time (Classic, Reforged DE or HD): a Classic model is used as
// it is, a DE or HD one is converted to a Classic model. Resolves with the chosen path and the mode
// it was chosen from, or null.

import type { W3Api } from "../../extensions/api";
import { ModelPreview } from "../../lib/model/preview";
import { h } from "../../workbench/dom";

export interface ModelChoice { path: string; label: string; detail: string }
/** The graphics mode a model is taken from. */
export type PickMode = "classic" | "de" | "hd";
export interface ModeChoices { mode: PickMode; label: string; choices: ModelChoice[] }
export interface Picked { path: string; mode: PickMode }

/** At most this many rows are listed (refine the search for the rest). */
const SHOWN = 300;

export function pickClassicModel(w3: W3Api, opts: { title: string; current: string | null; modes: ModeChoices[] }): Promise<Picked | null> {
  return new Promise((resolve) => {
    // The type's model as it is (only Reforged has it), the candidate as its mode shows it.
    const now = new ModelPreview(w3, { prefer: "reforged" });
    const candidate = new ModelPreview(w3, { prefer: "classic" });
    now.show(opts.current);
    let mode = opts.modes[0];
    const modeSelect = h("select.model-pick-mode", { title: "The graphics mode to take the model from. A DE or HD model is converted to a Classic model in the map." },
      ...opts.modes.map((m) => h("option", { value: m.mode }, m.label))) as HTMLSelectElement;
    modeSelect.addEventListener("change", () => {
      mode = opts.modes.find((m) => m.mode === modeSelect.value) ?? mode;
      candidate.setPrefer(mode.mode === "classic" ? "classic" : mode.mode);
      search.placeholder = `Search ${mode.label} models…`;
      filter();
    });
    const search = h("input.model-pick-search", { type: "search", placeholder: `Search ${mode.label} models…` }) as HTMLInputElement;
    const list = h("div.model-pick-list");
    const count = h("div.muted.model-pick-count");
    const candidateName = h("div.model-pick-caption");
    let shown: ModelChoice[] = [];
    let index = 0;

    const close = (result: Picked | null) => {
      now.dispose();
      candidate.dispose();
      overlay.remove();
      resolve(result);
    };
    const highlight = (i: number) => {
      index = Math.max(0, Math.min(shown.length - 1, i));
      [...list.children].forEach((row, k) => row.classList.toggle("active", k === index));
      list.children[index]?.scrollIntoView({ block: "nearest" });
      const c = shown[index];
      candidate.show(c?.path ?? null);
      candidateName.textContent = c ? `${mode.label}: ${c.label}` : `${mode.label}: —`;
      candidateName.title = c?.path ?? "";
    };
    const filter = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const all = mode.choices.filter((c) => words.every((w) => c.path.toLowerCase().includes(w)));
      shown = all.slice(0, SHOWN);
      count.textContent = all.length > SHOWN ? `${SHOWN} of ${all.length} shown — refine the search` : `${all.length} models`;
      list.replaceChildren(...shown.map((c, i) => h("div.model-pick-row", {
        title: c.path,
        onclick: () => highlight(i),
        ondblclick: () => close({ path: c.path, mode: mode.mode }),
      }, h("span", {}, c.label), h("small.muted", {}, c.detail))));
      highlight(0);
    };
    search.addEventListener("input", filter);
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { highlight(index + 1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { highlight(index - 1); e.preventDefault(); }
      else if (e.key === "PageDown") { highlight(index + 10); e.preventDefault(); }
      else if (e.key === "PageUp") { highlight(index - 10); e.preventDefault(); }
      else if (e.key === "Enter") { if (shown[index]) close({ path: shown[index].path, mode: mode.mode }); e.preventDefault(); }
      else if (e.key === "Escape") { close(null); e.preventDefault(); }
    });

    const overlay = h("div.model-pick-backdrop", { onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); } },
      h("div.model-pick", {},
        h("div.model-pick-title", {}, opts.title),
        h("div.model-pick-body", {},
          h("div.model-pick-left", {}, opts.modes.length > 1 ? modeSelect : null, search, count, list),
          h("div.model-pick-right", {},
            h("div.model-pick-caption", { title: opts.current ?? "" }, `Now: ${opts.current?.split(/[\\/]/).pop() ?? "—"}`), now.el,
            candidateName, candidate.el)),
        h("div.model-pick-actions", {},
          h("button", { onclick: () => close(null) }, "Cancel"),
          h("button.primary-inline", { onclick: () => close(shown[index] ? { path: shown[index].path, mode: mode.mode } : null) }, "Use this model"))));
    document.body.append(overlay);
    filter();
    search.focus();
  });
}
