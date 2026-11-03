// Name help for code editors: completion while typing (Ctrl+Space too), the
// declaration of the name under the mouse, and go to definition (F12 or
// Ctrl+click) for names declared in the same text. Symbols come from the
// editor's owner (for JASS: the game's scripts, the map script and the text).

import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import type { CodeSymbol } from "../../extensions/services";
import { h } from "../../workbench/dom";

const COMPLETION_TYPE: Record<string, string> = {
  function: "function", native: "function", global: "variable", constant: "constant", local: "variable", param: "variable", type: "type", keyword: "keyword",
};

/** Symbols visible at `pos`: locals and parameters only inside their function. */
function visible(symbols: CodeSymbol[], pos: number): CodeSymbol[] {
  return symbols.filter((s) => !s.scope || (pos >= s.scope[0] && pos <= s.scope[1]));
}

/** The symbol named `name` at `pos`, innermost first (a local before a global of the same name). */
function lookup(symbols: CodeSymbol[], name: string, pos: number): CodeSymbol | undefined {
  const all = visible(symbols, pos).filter((s) => s.name === name);
  return all.find((s) => s.scope) ?? all.find((s) => s.at !== undefined) ?? all[0];
}

function wordAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const w = view.state.wordAt(pos);
  return w ? { from: w.from, to: w.to, text: view.state.sliceDoc(w.from, w.to) } : null;
}

export function symbolTools(symbols: (text: string) => Promise<CodeSymbol[]>): Extension {
  const current = (view: EditorView) => symbols(view.state.sliceDoc());
  const goTo = async (view: EditorView, pos: number) => {
    const w = wordAt(view, pos);
    if (!w) return false;
    const s = lookup(await current(view), w.text, pos);
    if (s?.at === undefined) return false;
    view.dispatch({ selection: { anchor: s.at, head: s.at + s.name.length }, scrollIntoView: true });
    view.focus();
    return true;
  };
  return [
    autocompletion({
      override: [async (ctx: CompletionContext) => {
        const word = ctx.matchBefore(/\w+/);
        if (!word && !ctx.explicit) return null;
        // Not inside strings or comments.
        const line = ctx.state.doc.lineAt(ctx.pos);
        const before = line.text.slice(0, ctx.pos - line.from);
        if (/\/\//.test(before) || (before.match(/"/g)?.length ?? 0) % 2 === 1) return null;
        const list = visible(await symbols(ctx.state.sliceDoc()), ctx.pos);
        const seen = new Set<string>();
        const options: Completion[] = [];
        for (const s of list) {
          if (seen.has(s.name)) continue;
          seen.add(s.name);
          options.push({ label: s.name, type: COMPLETION_TYPE[s.kind] ?? "variable", detail: s.kind === "function" || s.kind === "native" ? "function" : s.kind, info: s.detail,
            boost: s.scope ? 2 : s.at !== undefined ? 1 : 0 });
        }
        return { from: word ? word.from : ctx.pos, options, validFor: /^\w*$/ };
      }],
    }),
    hoverTooltip(async (view, pos) => {
      const w = wordAt(view, pos);
      if (!w) return null;
      const s = lookup(await current(view), w.text, pos);
      if (!s) return null;
      return {
        pos: w.from, end: w.to, above: true,
        create: () => ({ dom: h("div.cm-symbol-tip", {}, h("code", {}, s.detail), s.at !== undefined ? h("div.muted", {}, "F12 / Ctrl+click: go to definition") : null) }),
      };
    }),
    keymap.of([{ key: "F12", run: (view) => { void goTo(view, view.state.selection.main.head); return true; } }]),
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        e.preventDefault();
        void goTo(view, pos);
        return true;
      },
    }),
  ];
}
