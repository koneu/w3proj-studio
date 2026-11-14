// "Check with JassHelper" on one trigger text: what JassHelper gets and where its errors belong.
//
// The text is compiled inside the map's script (Map Script's generator: the other custom texts in the script's
// order, the triggers, the generated globals), since a text alone doesn't compile when it is right: a library that
// requires another gave "Missing requirement", a placed unit's global "Undeclared variable". So that an error can
// be told to be in this text, in another one or in the generated script, every custom text goes in between two
// comment lines (markTexts). JassHelper reports lines of the file its failing step read
// (logs\currentmapscript.j; measured with the game's jasshelper.exe, 2026-11-14):
//   - step 1 (textmacros, libraries, scopes): the input itself, so a line is found by the marks alone;
//   - later steps and pjass: the script after step 1, where each library's code has moved to the top between
//     "//library <name>:" and "//library <name> ends" and other comments (the marks too) stayed in place. The text
//     is found by the library's name or the marks, and the line in it by what the line says.

import { textTriggers, type CustomTextFile, type TriggerFile, type TriggerItem } from "../../lib/triggers/wtg";

const MARK = "//w3proj-check";

/** The texts of a check: 0 is the map header, k + 1 the text of the k-th trigger or script item (textTriggers). */
export interface MarkedTexts {
  triggers: TriggerFile;
  custom: CustomTextFile;
  /** What each text is called in a message. */
  names: string[];
  /** The checked text. */
  own: number;
}

/** The trigger file and custom texts to generate the checked script from: every text between its two marks, and the
 *  checked item switched on (a text that is off isn't in the map's script, and is checked as if it were on).
 *  `nonce`: part of the marks, so that nothing in a text can look like one. Nothing given is changed. */
export function markTexts(triggers: TriggerFile, custom: CustomTextFile, item: TriggerItem, nonce: string): MarkedTexts {
  const items = textTriggers(triggers);
  const mark = (text: string | null, k: number) => {
    // A text of line breaks only holds no code to report on: left as it is.
    if (text === null || !/[^\r\n]/.test(text)) return text;
    // Whole lines of their own: without them the script is the map's, line for line.
    return `${MARK} ${nonce} ${k} begin\r\n${text}\r\n${MARK} ${nonce} ${k} end`;
  };
  return {
    triggers: { ...triggers, items: triggers.items.map((i) => (i === item ? { ...item, enabled: true, isComment: 0 } : i)) },
    custom: { ...custom, header: mark(custom.header, 0), texts: items.map((_, k) => mark(custom.texts[k] ?? null, k + 1)) },
    names: ["the map header", ...items.map((i) => `"${i.name}"`)],
    own: items.indexOf(item) + 1,
  };
}

interface Range { text: number; /** The lines between the marks, from 1. */ first: number; last: number }

/** The marked texts found in a script's lines. */
function ranges(lines: string[], nonce: string): Range[] {
  const out: Range[] = [];
  const open = new Map<number, number>();
  const prefix = `${MARK} ${nonce} `;
  lines.forEach((l, n) => {
    if (!l.startsWith(prefix)) return;
    const [k, what] = l.slice(prefix.length).trim().split(" ");
    const text = Number(k);
    if (what === "begin") open.set(text, n + 1);
    else if (what === "end" && open.has(text)) { out.push({ text, first: open.get(text)! + 1, last: n }); open.delete(text); }
  });
  return out;
}

const split = (script: string) => script.split(/\r\n|\r|\n/);
/** A line as JassHelper may have written it again: without its spaces. */
const bare = (line: string) => line.replace(/\s+/g, "");

/** One line of JassHelper's errors. */
export interface CheckError {
  message: string;
  /** The text it is in (MarkedTexts); null: the generated part of the script, or unknown. */
  text: number | null;
  /** The line in that text, from 1, when it could be told. */
  line?: number;
  /** What the line said in the script JassHelper was reading, when that isn't the text's own line. */
  code?: string;
}

/** JassHelper's errors with the text and line each belongs to.
 *  `log`: logs\compileerrors.txt; `input`: the script it was given (generated from markTexts' result);
 *  `current`: logs\currentmapscript.j, null if it couldn't be read. */
export function placeErrors(log: string, input: string, current: string | null, nonce: string): CheckError[] {
  const inLines = split(input);
  const inRanges = ranges(inLines, nonce);
  const out: CheckError[] = [];
  let step = "";
  const other: string[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const l = raw.trim();
    // The script's file name comes first, the number of errors last.
    if (!l || /^logs[\\/]/i.test(l) || /^\d+$/.test(l)) continue;
    const m = /^Line (\d+):\s*(.*)$/.exec(l);
    if (!m) { step = l; other.push(l); continue; }
    const n = Number(m[1]);
    const message = m[2];
    // Step 1 reads the input.
    if (/\bStep 1\b/.test(step)) {
      const r = inRanges.find((x) => n >= x.first && n <= x.last);
      out.push(r ? { message, text: r.text, line: n - r.first + 1 } : { message, text: null, ...(inLines[n - 1]?.trim() ? { code: inLines[n - 1].trim() } : {}) });
      continue;
    }
    // A later step's lines are of the script it read; without that one they aren't taken for the input's.
    out.push(current === null ? { message, text: null } : { message, ...placeCompiled(split(current), n, inLines, inRanges, nonce) });
  }
  // No line at all (JassHelper failed otherwise): what it said.
  if (!out.length && other.length) out.push({ message: other.join(" · "), text: null });
  return out;
}

/** Where line `n` of the script after step 1 comes from. */
function placeCompiled(cur: string[], n: number, inLines: string[], inRanges: Range[], nonce: string): Omit<CheckError, "message"> {
  // JassHelper has given line numbers far outside the script ("Line 1881173120: Missing: endblock").
  const said = cur[n - 1];
  if (said === undefined) return { text: null };
  const code = said.trim();
  // The block the line is in: a library's moved code, else a text's marks.
  let start = -1;
  let range: Range | undefined;
  for (let k = n - 2; k >= 0 && start < 0; k--) {
    if (/^\/\/library \w+ ends\s*$/.test(cur[k])) break;
    const lib = /^\/\/library (\w+):\s*$/.exec(cur[k]);
    if (!lib) continue;
    start = k;
    const declares = new RegExp(`^\\s*library(?:_once)?\\s+${lib[1]}\\b`);
    range = inRanges.find((r) => inLines.slice(r.first - 1, r.last).some((l) => declares.test(l)));
  }
  if (start < 0) {
    const here = ranges(cur, nonce).find((r) => n >= r.first && n <= r.last);
    if (here) { start = here.first - 1; range = inRanges.find((r) => r.text === here.text); }
  }
  if (!range) return { text: null, ...(code ? { code } : {}) };
  // The line in the text: the one that says the same, the n-th of them when several do (and as many as in the block).
  const want = bare(said);
  const same = [];
  for (let k = range.first; k <= range.last; k++) if (bare(inLines[k - 1]) === want) same.push(k - range.first + 1);
  let before = 0, all = 0;
  for (let k = start; k < cur.length && !/^\/\/library \w+ ends\s*$/.test(cur[k]) && !(k > start && cur[k].startsWith(`${MARK} ${nonce} `)); k++) {
    if (bare(cur[k]) !== want) continue;
    all++;
    if (k < n - 1) before++;
  }
  const line = same.length === 1 ? same[0] : same.length > 1 && same.length === all ? same[before] : undefined;
  return line === undefined ? { text: range.text, ...(code ? { code } : {}) } : { text: range.text, line };
}

/** What the check says: the checked text's errors first (by its own lines), then the others with where they are.
 *  JassHelper stops at the first step that fails, so errors elsewhere are told too: with them it hasn't looked
 *  at the rest of this text. */
export function checkMessages(errors: CheckError[], texts: Pick<MarkedTexts, "names" | "own">): { own: string[]; others: string[] } {
  const own: string[] = [], others: string[] = [];
  for (const e of errors) {
    const said = e.code ? ` (at: ${e.code})` : "";
    if (e.text === texts.own) own.push(e.line ? `Line ${e.line}: ${e.message}` : `${e.message}${said}`);
    else if (e.text === null) others.push(`in the map's script: ${e.message}${said}`);
    else others.push(`in ${texts.names[e.text] ?? "another text"}${e.line ? `, line ${e.line}` : ""}: ${e.message}${said}`);
  }
  return { own, others };
}
