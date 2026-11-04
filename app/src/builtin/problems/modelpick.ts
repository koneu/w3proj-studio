// The model picker of the "Use a Classic model instead…" fix: a searchable list of the game's
// Classic models beside two live previews, the type's current (Reforged) model and the
// highlighted candidate as Classic graphics shows it. Resolves with the chosen path, or null.

import type { W3Api } from "../../extensions/api";
import { ModelPreview } from "../../lib/model/preview";
import { h } from "../../workbench/dom";

export interface ModelChoice { path: string; label: string; detail: string }

/** At most this many rows are listed (refine the search for the rest). */
const SHOWN = 300;

export function pickClassicModel(w3: W3Api, opts: { title: string; current: string | null; choices: ModelChoice[] }): Promise<string | null> {
  return new Promise((resolve) => {
    const now = new ModelPreview(w3);
    const candidate = new ModelPreview(w3, { classic: true });
    now.show(opts.current);
    const search = h("input.model-pick-search", { type: "search", placeholder: "Search Classic models…" }) as HTMLInputElement;
    const list = h("div.model-pick-list");
    const count = h("div.muted.model-pick-count");
    const candidateName = h("div.model-pick-caption");
    let shown: ModelChoice[] = [];
    let index = 0;

    const close = (result: string | null) => {
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
      candidateName.textContent = c ? `Classic: ${c.label}` : "Classic: —";
      candidateName.title = c?.path ?? "";
    };
    const filter = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const all = opts.choices.filter((c) => words.every((w) => c.path.toLowerCase().includes(w)));
      shown = all.slice(0, SHOWN);
      count.textContent = all.length > SHOWN ? `${SHOWN} of ${all.length} shown — refine the search` : `${all.length} models`;
      list.replaceChildren(...shown.map((c, i) => h("div.model-pick-row", {
        title: c.path,
        onclick: () => highlight(i),
        ondblclick: () => close(c.path),
      }, h("span", {}, c.label), h("small.muted", {}, c.detail))));
      highlight(0);
    };
    search.addEventListener("input", filter);
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { highlight(index + 1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { highlight(index - 1); e.preventDefault(); }
      else if (e.key === "PageDown") { highlight(index + 10); e.preventDefault(); }
      else if (e.key === "PageUp") { highlight(index - 10); e.preventDefault(); }
      else if (e.key === "Enter") { if (shown[index]) close(shown[index].path); e.preventDefault(); }
      else if (e.key === "Escape") { close(null); e.preventDefault(); }
    });

    const overlay = h("div.model-pick-backdrop", { onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); } },
      h("div.model-pick", {},
        h("div.model-pick-title", {}, opts.title),
        h("div.model-pick-body", {},
          h("div.model-pick-left", {}, search, count, list),
          h("div.model-pick-right", {},
            h("div.model-pick-caption", { title: opts.current ?? "" }, `Now: ${opts.current?.split(/[\\/]/).pop() ?? "—"}`), now.el,
            candidateName, candidate.el)),
        h("div.model-pick-actions", {},
          h("button", { onclick: () => close(null) }, "Cancel"),
          h("button.primary-inline", { onclick: () => close(shown[index]?.path ?? null) }, "Use this model"))));
    document.body.append(overlay);
    filter();
    search.focus();
  });
}
