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
import { NotUtf8Error } from "../../workbench/backend";
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

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const status = w3.statusBar.add({ id: "w3.textEditor.cursor", text: "", align: "right", priority: 10 });
  ctx.subscriptions.push(status);

  ctx.subscriptions.push(
    w3.editors.registerProvider("w3.textEditor", {
      async resolve(el, doc) {
        let text: string;
        try {
          text = await doc.readText();
        } catch (e) {
          if (e instanceof NotUtf8Error) {
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
        const view = new EditorView({
          parent: el,
          state: EditorState.create({
            doc: text,
            extensions: [
              EditorState.lineSeparator.of(eol),
              EditorState.readOnly.of(doc.readOnly),
              lineNumbers(),
              highlightActiveLineGutter(),
              foldGutter(),
              history(),
              drawSelection(),
              indentOnInput(),
              bracketMatching(),
              highlightActiveLine(),
              highlightSelectionMatches(),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
              oneDark,
              language(doc.path),
              EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--mono)" } }),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) doc.setDirty(u.state.sliceDoc() !== saved);
                if (u.docChanged || u.selectionSet || u.focusChanged) updateStatus(u.view);
              }),
            ],
          }),
        });
        updateStatus(view);
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
            view.destroy();
            status.text = "";
          },
        };
      },
    }),
  );
}
