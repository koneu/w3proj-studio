// Problem markers for code editors: a check function runs after typing pauses;
// its diagnostics are underlined (message on hover) and listed below the editor,
// where clicking one moves the cursor there.

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { Diagnostic } from "../../lib/jass/check";
import { h } from "../../workbench/dom";

const setDiagnostics = StateEffect.define<Diagnostic[]>();

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setDiagnostics)) continue;
      const len = tr.state.doc.length;
      deco = Decoration.set(e.value
        .map((d) => ({ d, from: Math.min(d.from, len), to: Math.min(Math.max(d.to, d.from + 1), len) }))
        .filter((x) => x.to > x.from)
        .map((x) => Decoration.mark({ class: `cm-diag-${x.d.severity}`, attributes: { title: x.d.message } }).range(x.from, x.to)), true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Runs `check` on the text after changes (debounced) and shows its results; `list` gets the summary. */
export function linter(check: (text: string) => Promise<Diagnostic[]> | Diagnostic[], list: HTMLElement): { extension: Extension; start(view: EditorView): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined, run = 0;
  const go = (view: EditorView) => {
    const n = ++run;
    // The document's own text: diagnostics are positions in it, also in CRLF files.
    void Promise.resolve(check(view.state.doc.toString())).then((diags) => {
      if (n !== run) return;
      view.dispatch({ effects: setDiagnostics.of(diags) });
      render(view, diags);
    }).catch(() => { /* checking is best effort */ });
  };
  const render = (view: EditorView, diags: Diagnostic[]) => {
    list.hidden = !diags.length;
    if (!diags.length) { list.replaceChildren(); return; }
    const sorted = [...diags].sort((a, b) => a.from - b.from);
    list.replaceChildren(h("div.cm-diag-count", {}, `${diags.length} problem${diags.length === 1 ? "" : "s"}`),
      ...sorted.slice(0, 50).map((d) => {
        const line = view.state.doc.lineAt(Math.min(d.from, view.state.doc.length));
        return h(`div.cm-diag-row.${d.severity}`, { onclick: () => { view.dispatch({ selection: { anchor: Math.min(d.from, view.state.doc.length) }, scrollIntoView: true }); view.focus(); } },
          h("span.cm-diag-line", {}, `Ln ${line.number}`), d.message);
      }));
  };
  return {
    extension: [
      field,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) { clearTimeout(timer); timer = setTimeout(() => go(u.view), 500); }
      }),
    ],
    /** The first check, once the editor exists. */
    start: (view: EditorView) => go(view),
    stop: () => { clearTimeout(timer); run++; },
  };
}
