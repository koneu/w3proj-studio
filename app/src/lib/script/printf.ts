// The World Editor writes the map's custom script header (war3map.wct's first text; not the trigger texts, script
// items or vJASS libraries) into the map script through C's printf with no arguments, so a % in it starts a
// conversion (measured 2026-11-22, tests/we-compare/header-printf.json; JassHelper on or off alike):
//
//   %  [flags - + space # 0]  [width: digits or *]  [.precision: digits or *]  [length: h l L I I32 I64 w j z t ...]  c
//
// A char that can't come next ends the sequence and is printed in place of all of it: "%%" and "%*%" give "%", "%|"
// and "%*|" give "|", "%**" gives "*", "5%\n" gives "5\n". A conversion c (d i u x o c e f g a p ...) prints an argument
// that isn't there: a number from the editor's stack, not reproducible; s, S, n and Z crash the editor's save. Those
// are left as written and reported (headerPrintfIssues).

/** A conversion of the header that Studio can't write as the World Editor does: `at` is its offset in the header. */
export interface PrintfIssue {
  /** The sequence as written, e.g. "%5d", "% s". */
  spec: string;
  at: number;
  /** 1-based line of the header it starts on. */
  line: number;
  /** garbage: the editor prints a number of its own there; crash: the editor's save crashes. */
  kind: "garbage" | "crash";
}

const FLAGS = "-+ #0";
const DIGITS = "0123456789";
/** Length modifiers: hh, ll, I32 and I64 are one each. */
const LENGTHS = "hlLIwjztT";
const GARBAGE = "cCdiouxXeEfFgGaAp";
/** Conversions that crash the save: s, S and Z read a string from a pointer that isn't there, n writes through one. N
 *  (once a length modifier) crashes it too, and so does a second length modifier after a whole one (%lz, %hhh): the
 *  C runtime's check of the format stops the editor (header-printf-new, 2026-11-22: %lz and %N crashed it). */
const CRASH = "sSnZN";

/** One sequence starting at text[at] === "%": where it ends (exclusive), what it prints and whether it is a conversion. */
function sequence(text: string, at: number): { end: number; out: string; kind?: PrintfIssue["kind"] } {
  type State = "percent" | "flag" | "width" | "dot" | "precision" | "length";
  let state: State = "percent";
  let i = at + 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if ((state === "percent" || state === "flag") && FLAGS.includes(c)) { state = "flag"; continue; }
    if ((state === "percent" || state === "flag") && c === "*") { state = "width"; continue; }
    if ((state === "percent" || state === "flag" || state === "width") && DIGITS.includes(c)) { state = "width"; continue; }
    if ((state === "percent" || state === "flag" || state === "width") && c === ".") { state = "dot"; continue; }
    if (state === "dot" && (c === "*" || DIGITS.includes(c))) { state = "precision"; continue; }
    if (state === "precision" && DIGITS.includes(c)) continue;
    if (LENGTHS.includes(c)) {
      if (state === "length") return { end: i + 1, out: text.slice(at, i + 1), kind: "crash" };
      // hh, ll, I32 and I64 are one modifier ("%I3|" is I, then a 3 that ends it).
      if (c === "I" && (text.startsWith("32", i + 1) || text.startsWith("64", i + 1))) i += 2;
      else if ((c === "h" || c === "l") && text[i + 1] === c) i += 1;
      state = "length";
      continue;
    }
    if (GARBAGE.includes(c)) return { end: i + 1, out: text.slice(at, i + 1), kind: "garbage" };
    if (CRASH.includes(c)) return { end: i + 1, out: text.slice(at, i + 1), kind: "crash" };
    // Anything else (a second %, a char that can't come here) ends it and is printed for it.
    return { end: i + 1, out: c };
  }
  // The text ends inside the sequence: nothing is printed for it.
  return { end: i, out: "" };
}

/** The header as the World Editor's printf writes it; conversions it can't reproduce stay as written. */
export function headerPrintf(text: string): string {
  if (!text.includes("%")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const p = text.indexOf("%", i);
    if (p < 0) { out += text.slice(i); break; }
    out += text.slice(i, p);
    const s = sequence(text, p);
    out += s.out;
    i = s.end;
  }
  return out;
}

/** What an issue means, for a message: "% s (line 2): the World Editor's save crashes on it". */
export function printfIssueText(i: PrintfIssue): string {
  return `"${i.spec}" (line ${i.line}): ${i.kind === "crash" ? "the World Editor's save crashes on it" : "the World Editor writes a number of its own for it"}`;
}

/** One sentence about all of a header's issues, for the output; "" for none. */
export function printfIssuesText(issues: PrintfIssue[]): string {
  if (!issues.length) return "";
  const listed = issues.slice(0, 5).map(printfIssueText).join("; ");
  return `the custom script header has printf conversions Studio keeps as written: ${listed}${issues.length > 5 ? `; and ${issues.length - 5} more` : ""} (write %% for a %)`;
}

/** The conversions of the header Studio leaves as written (headerPrintf) where the World Editor prints a number of its
 *  own or crashes on save. */
export function headerPrintfIssues(text: string): PrintfIssue[] {
  const issues: PrintfIssue[] = [];
  let i = 0;
  while (i < text.length) {
    const p = text.indexOf("%", i);
    if (p < 0) break;
    const s = sequence(text, p);
    if (s.kind) issues.push({ spec: s.out, at: p, line: text.slice(0, p).split("\n").length, kind: s.kind });
    i = s.end;
  }
  return issues;
}
