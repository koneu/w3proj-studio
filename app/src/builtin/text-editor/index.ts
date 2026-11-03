import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { bracketMatching, foldGutter, indentOnInput, StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, type CodeEditorOptions, type CodeEditorService } from "../../extensions/services";
import { checkJass, envWithout } from "../../lib/jass/check";
import { gameJassEnv, jassSymbols } from "../../lib/jass/env";
import { symbolTools } from "./jasstools";
import { linter } from "./lint";
import { h } from "../../workbench/dom";
import { jass } from "./jass";

function language(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "j":
    case "ai":
      return StreamLanguage.define(jass);
    case "lua":
      return StreamLanguage.define(lua);
    case "json":
      return json();
    case "toml":
      return StreamLanguage.define(toml);
    default:
      return [];
  }
}

/** Majority line ending. CodeMirror splits lines only on this separator and
 *  joins with it on save, so other break characters stay byte-exact. */
function lineEnding(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  if (cr > crlf && cr > lf) return "\r";
  return crlf > lf ? "\r\n" : "\n";
}

/** The editing basics every code view shares (highlighting by `lang`, theme, keys). */
function basics(lang: Extension, readOnly: boolean): Extension[] {
  return [
    EditorState.readOnly.of(readOnly),
    lineNumbers(), highlightActiveLineGutter(), foldGutter(), history(), drawSelection(), indentOnInput(),
    bracketMatching(), highlightActiveLine(), highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    oneDark, lang,
  ];
}

/** Code editors embedded in other extensions' views (custom script triggers, the map header). */
/** Open text editors by path, to show a declaration in a file that is already open. */
const openViews = new Map<string, EditorView>();
/** Declarations to show once their file opens (go to definition into a game script). */
const pendingReveal = new Map<string, string>();
/** Opens a game script at a declaration (set up in activate). */
let openGameScript = (_path: string, _name: string) => {};

/** Selects where `name` is declared (native, function, global) and scrolls there. */
function reveal(view: EditorView, name: string) {
  const text = view.state.sliceDoc();
  const re = [
    new RegExp(String.raw`^[ \t]*(?:constant[ \t]+)?(?:native|function)[ \t]+${name}\b`, "m"),
    new RegExp(String.raw`^[ \t]*(?:constant[ \t]+)?\w+[ \t]+(?:array[ \t]+)?${name}\b`, "m"),
  ];
  for (const r of re) {
    const m = r.exec(text);
    if (!m) continue;
    const at = m.index + m[0].length - name.length;
    view.dispatch({ selection: { anchor: at, head: at + name.length }, scrollIntoView: true });
    view.focus();
    return;
  }
}

/** Go to definition outside the text: game scripts here, the rest by the editor's owner. */
const elsewhere = (owner?: (location: string, name: string) => void) => (location: string, name: string) => {
  if (location.startsWith("game:")) openGameScript(location, name);
  else owner?.(location, name);
};

const codeEditors: CodeEditorService = {
  create(parent, opts: CodeEditorOptions) {
    const eol = lineEnding(opts.value);
    let committed = opts.value, timer: ReturnType<typeof setTimeout> | undefined;
    const problems = h("div.cm-diag-list", { hidden: true });
    const lint = opts.check ? linter(opts.check, problems) : null;
    const commit = () => {
      clearTimeout(timer);
      const v = view.state.sliceDoc();
      if (v !== committed) { committed = v; opts.onChange?.(v); }
    };
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: opts.value,
        extensions: [
          EditorState.lineSeparator.of(eol),
          ...basics(language(`x.${opts.language === "jass" ? "j" : opts.language}`), !!opts.readOnly),
          EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)", minHeight: "8em" } }),
          ...(lint ? [lint.extension] : []),
          ...(opts.symbols ? [symbolTools(opts.symbols, elsewhere(opts.openLocation?.bind(opts)))] : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) { clearTimeout(timer); timer = setTimeout(commit, opts.debounce ?? 600); }
            if (u.focusChanged && !u.view.hasFocus) commit();
          }),
        ],
      }),
    });
    parent.append(problems);
    lint?.start(view);
    return {
      value: () => view.state.sliceDoc(),
      focus: () => view.focus(),
      dispose: () => { commit(); lint?.stop(); view.destroy(); problems.remove(); },
    };
  },
};

export function activate(w3: W3Api, ctx: ExtensionContext) {
  openGameScript = (path, name) => {
    pendingReveal.set(path, name);
    void w3.editors.open(path, "w3.textEditor").then(() => {
      // Already open: the view exists and just moves.
      const view = openViews.get(path);
      if (view && pendingReveal.get(path) === name) { pendingReveal.delete(path); reveal(view, name); }
    }).catch((e) => w3.window.showError(String(e)));
  };
  ctx.subscriptions.push(w3.services.provide(CODE_EDITOR_SERVICE, codeEditors));
  const status = w3.statusBar.add({ id: "w3.textEditor.cursor", text: "", align: "right", priority: 10 });
  ctx.subscriptions.push(status);

  ctx.subscriptions.push(
    w3.editors.registerProvider("w3.textEditor", {
      async resolve(el, doc) {
        let text: string;
        try {
          text = await doc.readText();
        } catch (e) {
          if ((e as Error).name === "NotUtf8Error") {
            el.append(h("div.editor-error", {}, "This file is not UTF-8 text. ",
              h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.hexViewer") }, "Open in Binary Viewer")));
            return {};
          }
          throw e;
        }
        const eol = lineEnding(text);
        let saved = text;
        const updateStatus = (view: EditorView) => {
          const pos = view.state.selection.main.head;
          const line = view.state.doc.lineAt(pos);
          status.text = `Ln ${line.number}, Col ${pos - line.from + 1}  ${eol === "\r\n" ? "CRLF" : eol === "\r" ? "CR" : "LF"}  UTF-8${doc.readOnly ? "  read-only" : ""}`;
        };
        // JASS files are checked against the game's common.j and Blizzard.j (and themselves, in order);
        // AI scripts (.ai) also use common.ai, which isn't loaded.
        const jass = /\.j$/i.test(doc.path);
        const problems = h("div.cm-diag-list", { hidden: true });
        const lint = jass ? linter(async (t) => checkJass(t, envWithout(await gameJassEnv((p) => w3.game.readText(p)), t)), problems) : null;
        if (lint) el.classList.add("text-with-problems");
        const view = new EditorView({
          parent: el,
          state: EditorState.create({
            doc: text,
            extensions: [
              EditorState.lineSeparator.of(eol),
              ...basics(language(doc.path), doc.readOnly),
              ...(lint ? [lint.extension] : []),
              ...(jass ? [symbolTools(async (t) => jassSymbols(await gameJassEnv((p) => w3.game.readText(p)), t), elsewhere())] : []),
              EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--mono)" } }),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) doc.setDirty(u.state.sliceDoc() !== saved);
                if (u.docChanged || u.selectionSet || u.focusChanged) updateStatus(u.view);
              }),
            ],
          }),
        });
        updateStatus(view);
        openViews.set(doc.path, view);
        const want = pendingReveal.get(doc.path);
        if (want) { pendingReveal.delete(doc.path); requestAnimationFrame(() => reveal(view, want)); }
        if (lint) { el.append(problems); lint.start(view); }
        return {
          async save() {
            if (doc.readOnly) return;
            const t = view.state.sliceDoc();
            await doc.writeText(t);
            saved = t;
            doc.setDirty(false);
          },
          focus: () => view.focus(),
          dispose: () => {
            if (openViews.get(doc.path) === view) openViews.delete(doc.path);
            lint?.stop();
            view.destroy();
            status.text = "";
          },
        };
      },
    }),
  );
}
