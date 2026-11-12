// The extensions of both sides of a file's diff view: read-only, line numbers, long lines wrapped
// (cut at the pane's edge, a change past it couldn't be seen; as in Script Changes), JSON highlighted.

import { json } from "@codemirror/lang-json";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, lineNumbers } from "@codemirror/view";

export function diffExtensions(path: string): Extension[] {
  const lang = /\.json$/i.test(path) ? [json()] : [];
  return [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, lineNumbers(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark, ...lang];
}
