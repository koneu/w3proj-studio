// Name help for code editors: completion while typing (Ctrl+Space too), the
// declaration of the name under the mouse, go to definition (F12 or
// Ctrl+click: in the same text, a game script, or another trigger) and an
// outline of the text's functions above it. Symbols come from the editor's
// owner (for JASS: the game's scripts, the map script and the text).

import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, showPanel, type Panel } from "@codemirror/view";
import type { CodeSymbol, CompletionItem, CompletionRequest } from "../../extensions/services";
import { codeSpot, paramOf } from "../../lib/jass/callsite";
import { luaSpot } from "../../lib/lua/symbols";
import { h } from "../../workbench/dom";

const COMPLETION_TYPE: Record<string, string> = {
  function: "function", native: "function", global: "variable", constant: "constant", local: "variable", param: "variable", type: "type", keyword: "keyword",
  library: "namespace", struct: "class", method: "method", field: "property", macro: "text",
};
/** What the outline lists: declarations that structure a text. */
const OUTLINE = new Set(["library", "struct", "function", "method", "macro"]);

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

/** Where a symbol declared elsewhere is ("in common.j", "in trigger X"). */
function whereText(location: string): string {
  if (location.startsWith("trigger:")) return `in trigger ${location.slice(8)}`;
  return `in ${location.replace(/^game:/, "").split(/[\\/]/).pop()}`;
}

/** Completion from other extensions (CodeEditorService.registerCompletion). */
export type ExtraCompletion = (request: CompletionRequest) => Promise<CompletionItem[]>;

/** `openElsewhere` goes to a symbol declared outside the text (its `location`); `extra` adds other
 *  extensions' items (strings and rawcodes get only those). */
export function symbolTools(symbols: (text: string) => Promise<CodeSymbol[]>, openElsewhere: (location: string, name: string) => void,
  extra?: ExtraCompletion, language: "jass" | "lua" = "jass"): Extension {
  // The document's own text: its offsets are what positions in the editor mean, also in CRLF files
  // (sliceDoc gives the file's line breaks, two characters each).
  const current = (view: EditorView) => symbols(view.state.doc.toString());
  const goTo = async (view: EditorView, pos: number) => {
    const w = wordAt(view, pos);
    if (!w) return false;
    const s = lookup(await current(view), w.text, pos);
    if (s?.at === undefined) {
      if (s?.location) { openElsewhere(s.location, s.name); return true; }
      return false;
    }
    view.dispatch({ selection: { anchor: s.at, head: s.at + s.name.length }, scrollIntoView: true });
    view.focus();
    return true;
  };
  // The outline: the text's own functions (and vJASS libraries, structs, methods), in order;
  // picking one moves there.
  const outline = (view: EditorView): Panel => {
    const select = h("select.cm-outline", { title: "Declarations in this text", onchange: () => {
      const at = Number(select.value);
      if (Number.isFinite(at) && select.value !== "") { view.dispatch({ selection: { anchor: at }, scrollIntoView: true }); view.focus(); }
      select.value = "";
    } }) as HTMLSelectElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fill = () => void current(view).then((list) => {
      const items = list.filter((s) => s.at !== undefined && OUTLINE.has(s.kind)).sort((a, b) => a.at! - b.at!);
      const fns = items.filter((s) => s.kind === "function" || s.kind === "method").length;
      // Indented under their library/struct (non-breaking spaces: option text isn't laid out).
      const depth = new Map<string, number>();
      for (const s of items) if (s.kind === "library" || s.kind === "struct") depth.set(s.name, s.container ? (depth.get(s.container) ?? 0) + 1 : 0);
      const label = (s: CodeSymbol) => {
        const d = s.container !== undefined ? (depth.get(s.container) ?? 0) + 1 : 0;
        const what = s.kind === "function" || s.kind === "native" ? "" : `${s.kind === "macro" ? "textmacro" : s.detail.split(" ").find((w) => /^(library|library_once|scope|struct|module|interface|method)$/.test(w)) ?? s.kind} `;
        return `${String.fromCharCode(0xa0).repeat(3 * d)}${what}${s.name}`;
      };
      select.replaceChildren(h("option", { value: "" }, items.length ? (fns === items.length ? `Functions (${fns})…` : `Outline (${fns} functions)…`) : "No functions"),
        ...items.map((s) => h("option", { value: String(s.at) }, label(s))));
    }).catch(() => {});
    fill();
    return {
      dom: h("div.cm-outline-panel", {}, select),
      top: true,
      update: (u) => { if (u.docChanged) { clearTimeout(timer); timer = setTimeout(fill, 800); } },
      destroy: () => clearTimeout(timer),
    };
  };
  return [
    autocompletion({
      override: [async (ctx: CompletionContext) => {
        const text = ctx.state.doc.toString();
        const spot: ReturnType<typeof luaSpot> = language === "lua" ? luaSpot(text, ctx.pos) : codeSpot(text, ctx.pos);
        // Strings and rawcodes: what other extensions know (paths, labels, object ids).
        if (spot.inString || spot.inRawcode) {
          if (!extra) return null;
          if (!ctx.explicit && spot.prefix === "" && !/["']$/.test(ctx.state.sliceDoc(ctx.pos - 1, ctx.pos))) return null;
          // Without symbols (e.g. text the parser gives up on) paths and object ids are still offered.
          const all = await symbols(text).catch(() => [] as CodeSymbol[]);
          const sig = spot.call ? lookup(all, spot.call.name, ctx.pos)?.detail : undefined;
          const call = spot.call ? { ...spot.call, param: sig ? paramOf(sig, spot.call.argIndex) : undefined } : undefined;
          const items = await extra({ language, text, pos: ctx.pos, inString: spot.inString, inRawcode: spot.inRawcode, prefix: spot.prefix, call });
          if (!items.length) return null;
          // A string's backslashes are written doubled; a rawcode is closed if it isn't yet.
          const quote = spot.quote ?? "'";
          const close = spot.inRawcode && ctx.state.sliceDoc(ctx.pos, ctx.pos + 1) !== quote ? quote : "";
          return {
            from: spot.from, filter: false,
            options: items.map((it): Completion => ({
              label: it.label, detail: it.detail, info: it.info, type: it.kind ?? "text", boost: it.boost,
              apply: spot.inString ? (it.insert ?? it.label).replace(/\\/g, "\\\\").replace(/"/g, '\\"') : (it.insert ?? it.label) + close,
            })),
          };
        }
        const word = ctx.matchBefore(/\w+/);
        if (!word && !ctx.explicit) return null;
        // Not inside comments.
        const line = ctx.state.doc.lineAt(ctx.pos);
        const before = line.text.slice(0, ctx.pos - line.from);
        if (language === "lua" ? /--/.test(before) : /\/\//.test(before)) return null;
        const list = visible(await symbols(text), ctx.pos);
        const seen = new Set<string>();
        const options: Completion[] = [];
        for (const s of list) {
          if (seen.has(s.name)) continue;
          seen.add(s.name);
          options.push({ label: s.name, type: COMPLETION_TYPE[s.kind] ?? "variable", detail: s.kind === "function" || s.kind === "native" ? "function" : s.kind, info: s.detail,
            boost: s.scope ? 2 : s.at !== undefined ? 1 : 0 });
        }
        // Other extensions' items in code (e.g. a language's keywords).
        if (extra) {
          const items = await extra({ language, text, pos: ctx.pos, inString: false, inRawcode: false, prefix: word?.text ?? "", call: spot.call });
          for (const it of items) if (!seen.has(it.label)) { seen.add(it.label); options.push({ label: it.label, apply: it.insert, detail: it.detail, info: it.info, type: it.kind ?? "text", boost: it.boost }); }
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
        create: () => ({ dom: h("div.cm-symbol-tip", {}, h("code", {}, s.detail),
          s.at !== undefined ? h("div.muted", {}, "F12 / Ctrl+click: go to definition")
            : s.location ? h("div.muted", {}, `Declared ${whereText(s.location)} · F12 / Ctrl+click opens it`) : null) }),
      };
    }),
    keymap.of([{ key: "F12", run: (view) => { void goTo(view, view.state.selection.main.head); return true; } }]),
    showPanel.of(outline),
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
