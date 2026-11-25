// Per-file diagnostics of the trigger folders (map/triggers/): each script file (the header, every custom-text
// trigger and script item) is linted as the file it is, so a problem is told at `map/triggers/<file>:<line>`, the line
// an outside editor shows (the `// @w3proj {…}` frontmatter is line 1, a comment to the checkers). JASS files are
// checked as one trigger's text is in the Trigger Editor (trigger-script): against the game's scripts and the map
// script's declarations, without the file's own, its trigger's gg_trg_ global added, functions not ordered across
// files. vJASS files aren't (JassHelper compiles the whole script: "Check with JassHelper"). Lua files get
// lib/lua/check.ts: the syntax, and calls of names that neither the game's API, the map script nor the files define.
//
// The map script's own check (war3map.j / war3map.lua) then leaves to these what lies in a text it copied as it is:
// such a finding is told at the file's line once (dropped where the file's lint found the same line, moved to the file
// otherwise: a call to a function another text defines further down is only an error in the whole script).

import { checkJass, envWithout, type JassEnv } from "../jass/check";
import { checkLua } from "../lua/check";

/** vJASS source: libraries, scopes, structs, … (as the vJASS extension tells it, builtin/vjass/index.ts SOURCE). */
const VJASS = /^\s*(?:(?:private|public)\s+)?(?:library|scope|struct|module|interface|textmacro|endlibrary|endscope|endstruct)\b|^(?:(?!\/\/).)*\/\*|^\s*\/\/!/m;

export function isVjass(text: string): boolean {
  return VJASS.test(text);
}

/** A script file of the folders, as read. */
export interface TriggerText {
  /** Project path (map/triggers/…). */
  path: string;
  /** The file's text (its frontmatter line too). */
  text: string;
  /** The gg_trg_ global of its trigger (a custom-text trigger); null for the header and script items. */
  global?: string | null;
}

export interface TextDiagnostic {
  path: string;
  /** From 1, the file's own lines. */
  line: number;
  /** Where in the file as the text editor counts (a line break is one character, CRLF too): its reveal. */
  offset: number;
  message: string;
  severity: "error" | "warning";
}

/** A zero byte of a text is U+10FF00 in its file (crates/w3proj trigger_layout): two spaces stand for it in the check,
 *  which keeps every offset where it is. */
/** A byte order mark (written by its code, so the source has no invisible character). */
const BOM = String.fromCharCode(0xfeff);
const sane = (text: string) => text.replace(/\u{10FF00}/gu, "  ");
const lineAt = (text: string, at: number) => text.slice(0, at).split("\n").length;
const editorOffset = (text: string, at: number) => text.slice(0, at).replace(/\r\n/g, "\n").length;

/** Whether the file's first line (after a BOM) is the frontmatter. */
export function hasFrontmatter(text: string, lua: boolean): boolean {
  return new RegExp(`^\\uFEFF?${lua ? "--" : "//"} @w3proj(?:[ \\t{]|$)`, "m").test(text.split("\n", 1)[0]);
}

/** The diagnostics of each file. `env`: the game's scripts and the map script's and other files' declarations (JASS);
 *  `judgeGlobals`: whether an unknown udg_ or gg_ name is told (the Problems view leaves those to the whole script's
 *  check, whose findings in a file's text are moved to it: a kept script may not follow the triggers). `luaNames`:
 *  what Lua files may call (luaKnownNames: the game's API, the map script's and the other files' globals); null: Lua
 *  names aren't judged. */
export function lintTexts(texts: TriggerText[], language: "jass" | "lua", env: JassEnv | null, judgeGlobals: boolean, luaNames: ReadonlySet<string> | null = null): TextDiagnostic[] {
  const out: TextDiagnostic[] = [];
  for (const t of texts) {
    const text = sane(t.text);
    const found: { from: number; message: string; severity: "error" | "warning" }[] = [];
    if (language === "lua" || /\.lua$/i.test(t.path)) {
      for (const d of checkLua(text, luaNames)) found.push({ from: d.from, message: d.message, severity: d.severity });
    } else if (env && !/\.vjass$/i.test(t.path) && !isVjass(text)) {
      const own = envWithout(env, text);
      if (t.global) own.globals.set(t.global, { type: "trigger", array: false, constant: false });
      for (const d of checkJass(text, own, { ordered: false })) {
        if (!judgeGlobals && /^Unknown (?:variable|function) (?:udg_|gg_)/.test(d.message)) continue;
        found.push({ from: d.from, message: d.message, severity: d.severity });
      }
    }
    for (const d of found) out.push({ path: t.path, line: lineAt(text, d.from), offset: editorOffset(text, d.from), message: d.message, severity: d.severity });
  }
  return out;
}

/** A text's place in the map script: where its body (the file without its frontmatter) is, in the script with LF breaks. */
interface Region { path: string; start: number; end: number; /** Lines before the body in the file. */ before: number; /** Editor offset of the body in the file. */ bodyOffset: number }

/** Where the files' texts are in the map script, each found once (a text that isn't in it as it is has no place). */
function regions(script: string, texts: TriggerText[], language: "jass" | "lua"): Region[] {
  const s = script.replace(/\r\n/g, "\n");
  const out: Region[] = [];
  for (const t of texts) {
    const file = sane(t.text).replace(/\r\n/g, "\n");
    const front = hasFrontmatter(file, language === "lua" || /\.lua$/i.test(t.path));
    const cut = front ? file.indexOf("\n") + 1 : 0;
    const rest = file.slice(cut);
    const body = rest.startsWith(BOM) ? rest.slice(BOM.length) : rest;
    if (!/\S/.test(body) || (front && cut === 0)) continue;
    let from = 0;
    for (;;) {
      const at = s.indexOf(body, from);
      if (at < 0) break;
      const end = at + body.length;
      if (!out.some((r) => at < r.end && r.start < end)) { out.push({ path: t.path, start: at, end, before: front ? 1 : 0, bodyOffset: cut + (file.length - cut - body.length) }); break; }
      from = at + 1;
    }
  }
  return out;
}

/** The map script's findings (`from`: offsets into `script`) split: those in a text it copied as it is go to the file
 *  and line (`moved`; dropped where `perFile` already has that line of that file), the rest stay the script's. */
export function placeScriptDiagnostics<D extends { from: number; message: string; severity: "error" | "warning" }>(script: string, texts: TriggerText[], language: "jass" | "lua", diags: D[], perFile: TextDiagnostic[]): { kept: D[]; moved: TextDiagnostic[] } {
  const rs = regions(script, texts, language);
  if (!rs.length) return { kept: diags, moved: [] };
  const had = new Set(perFile.map((d) => `${d.path}\n${d.line}`));
  const s = script.replace(/\r\n/g, "\n");
  const kept: D[] = [], moved: TextDiagnostic[] = [];
  for (const d of diags) {
    const at = editorOffset(script, d.from);
    const r = rs.find((x) => at >= x.start && at < x.end);
    if (!r) { kept.push(d); continue; }
    const line = r.before + lineAt(s.slice(r.start), at - r.start);
    if (had.has(`${r.path}\n${line}`)) continue;
    had.add(`${r.path}\n${line}`);
    moved.push({ path: r.path, line, offset: r.bodyOffset + (at - r.start), message: d.message, severity: d.severity });
  }
  return { kept, moved };
}
