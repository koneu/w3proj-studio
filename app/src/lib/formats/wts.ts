// war3map.wts (trigger strings): `STRING <n> [// comment] { text }`.
// Edits replace only the text of changed blocks, so the rest of the file
// (comments, order, line endings) stays byte-identical.

/** A header `STRING <digits> [// …\n]* {` + `\r?\n`: where it starts, where its digits are, its number, where its
 *  text starts. */
interface Header { at: number; digits: number; digitsEnd: number; num: number; end: number }

/** JavaScript's `\s` (all of it lies in the Basic Multilingual Plane, so one UTF-16 unit each). */
function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The parser's searches over one text, read by hand rather than by regex: they match exactly what these did
 *  (each is deterministic, nothing to backtrack into)
 *    header:   /STRING\s+(\d+)\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n/
 *    close:    /\r?\n\}/
 *    unclosed: /\}(?=\r?\n(?:[ \t]*\r?\n)*<header>)/  (a `}` ending a text line, the next header right after it)
 *  but a run of `//` lines is read once however many header searches meet it (every `STRING` inside the run starts
 *  one; the regex read the rest of the run for each, quadratic time). The Rust port (crates/w3proj/src/wts.rs) is
 *  the same reader. */
export class WtsReader {
  /** Start of a `//` line (as the header's comment group meets it) → where the run of them ends. */
  private runs = new Map<number, number>();

  constructor(private text: string) {}

  private skipSpace(at: number): number {
    const t = this.text;
    while (at < t.length && isSpace(t.charCodeAt(at))) at++;
    return at;
  }

  /** `(?:\/\/[^\n]*\n\s*)*` from `at`: where it ends. */
  private comments(at: number): number {
    const t = this.text;
    const seen: number[] = [];
    let p = at, end: number;
    for (;;) {
      const known = this.runs.get(p);
      if (known !== undefined) { end = known; break; }
      if (!t.startsWith("//", p)) { end = p; break; }
      const nl = t.indexOf("\n", p + 2);
      if (nl < 0) { end = p; break; }
      seen.push(p);
      p = this.skipSpace(nl + 1);
    }
    for (const s of seen) this.runs.set(s, end);
    return end;
  }

  /** The header pattern anchored at `at`. */
  headerAt(at: number): Header | null {
    const t = this.text;
    if (!t.startsWith("STRING", at)) return null;
    const digits = this.skipSpace(at + 6);
    if (digits === at + 6) return null;
    let digitsEnd = digits;
    while (digitsEnd < t.length && t.charCodeAt(digitsEnd) >= 0x30 && t.charCodeAt(digitsEnd) <= 0x39) digitsEnd++;
    if (digitsEnd === digits) return null;
    const p = this.comments(this.skipSpace(digitsEnd));
    if (t.charCodeAt(p) !== 0x7b) return null; // {
    const end = t.startsWith("\r\n", p + 1) ? p + 3 : t.charCodeAt(p + 1) === 0x0a ? p + 2 : -1;
    if (end < 0) return null;
    return { at, digits, digitsEnd, num: Number(t.slice(digits, digitsEnd)), end };
  }

  /** The first header from `from`. */
  findHeader(from: number): Header | null {
    for (let i = this.text.indexOf("STRING", from); i >= 0; i = this.text.indexOf("STRING", i + 1)) {
      const h = this.headerAt(i);
      if (h) return h;
    }
    return null;
  }

  /** The first `\r?\n}` from `from`: where it starts and ends. */
  findClose(from: number): { index: number; end: number } | null {
    const i = this.text.indexOf("\n}", from);
    if (i < 0) return null;
    return i > from && this.text.charCodeAt(i - 1) === 0x0d ? { index: i - 1, end: i + 2 } : { index: i, end: i + 2 };
  }

  /** The first `}` from `from` with `\r?\n`, blank lines and a header right after it. */
  findUnclosed(from: number): number | null {
    const t = this.text;
    for (let i = t.indexOf("}", from); i >= 0; i = t.indexOf("}", i + 1)) {
      let p = i + 1;
      if (t.charCodeAt(p) === 0x0d) p++;
      if (t.charCodeAt(p) !== 0x0a) continue;
      p++;
      // (?:[ \t]*\r?\n)*
      for (;;) {
        let q = p;
        while (t.charCodeAt(q) === 0x20 || t.charCodeAt(q) === 0x09) q++;
        if (t.charCodeAt(q) === 0x0d) q++;
        if (t.charCodeAt(q) !== 0x0a) break;
        p = q + 1;
      }
      if (this.headerAt(p)) return i;
    }
    return null;
  }
}

/** One `STRING n { text }` block: `text.slice(from, to)` is the text, `text.slice(to, end)` what closes it; `head`
 *  its header. */
interface Block { head: Header; num: number; from: number; to: number; end: number; closed: boolean }

/** The blocks of a file. A block ends at the first line that starts with `}`. Some real files have
 *  a block whose `}` sits at the end of its last text line, with the next STRING block right after;
 *  there the first such `}` ends the block (before the next header, never anywhere else), so the next
 *  string isn't swallowed. That also holds when no `}` line follows at all. A last block without a
 *  header after it stays unread, as it is without a `}` line.
 *
 *  The next `}` line and the next unclosed `}` are each searched for once and kept while they still
 *  lie ahead, so a file of many unclosed blocks is read in one pass. */
function scan(text: string, r = new WtsReader(text)): Block[] {
  const blocks: Block[] = [];
  let pos = 0;
  let c: { index: number; end: number } | null | undefined, u: number | null | undefined; // undefined: not searched yet
  for (;;) {
    const h = r.findHeader(pos);
    if (!h) return blocks;
    const from = h.end;
    if (c === undefined || (c && c.index < from)) c = r.findClose(from);
    if (u === undefined || (u !== null && u < from)) u = r.findUnclosed(from);
    if (u !== null && (!c || u < c.index)) {
      blocks.push({ head: h, num: h.num, from, to: u, end: u + 1, closed: false });
      pos = u + 1;
    } else if (!c) {
      return blocks;
    } else {
      blocks.push({ head: h, num: h.num, from, to: c.index, end: c.end, closed: true });
      pos = c.end;
    }
  }
}

/** A string whose text the game (and this parser) would cut: its number and the lines (1-based) where it would end. */
export interface WtsCut { num: number; lines: number[] }

/** The lines (1-based) of a string's text at which the string would end when the file is read again: a
 *  line that starts with `}` (the game cut "Test 2" of map 17 at a line that was just `}` and dropped the
 *  rest; this parser ends a block at any line starting with `}`), and a line ending in `}` with a
 *  `STRING n {` header right after it (where this parser recovers an unclosed block). Empty: safe. */
export function wtsCutLines(value: string): number[] {
  const lines = value.split(/\r?\n/);
  const out: number[] = [];
  lines.forEach((l, i) => { if (l.startsWith("}")) out.push(i + 1); });
  if (out.length) return out;
  const norm = value.replace(/\r\n/g, "\n");
  const back = new StringTable(`STRING 1\n{\n${norm}\n}\n`).get(1);
  if (back === norm) return [];
  return [Math.min(lines.length, (back ?? "").split("\n").length)];
}

/** The text changed so it is read back whole: a space before every line that starts with `}`, and after a
 *  `}` that ends a line before a header. What the warning offers; the text otherwise stays as it is. */
export function wtsSafeText(value: string): string {
  let out = value.replace(/(^|\n)(?=\})/g, "$1 ");
  for (let i = 0; i < 100 && wtsCutLines(out).length; i++) {
    const at = wtsCutLines(out)[0];
    const lines = out.split("\n");
    lines[at - 1] = lines[at - 1].replace(/\}(\r?)$/, "} $1");
    const next = lines.join("\n");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** The strings among `values` whose text would be cut (see wtsCutLines). */
export function wtsCuts(values: Iterable<[number, string]>): WtsCut[] {
  const out: WtsCut[] = [];
  for (const [num, text] of values) {
    const lines = wtsCutLines(text);
    if (lines.length) out.push({ num, lines });
  }
  return out.sort((a, b) => a.num - b.num);
}

/** What's wrong with the strings, for a warning or a refusal. */
export function wtsCutMessage(cuts: WtsCut[]): string {
  const which = cuts.map((c) => `string ${c.num} (line ${c.lines.join(", ")})`).join(", ");
  return `${cuts.length === 1 ? "A text has" : `${cuts.length} texts have`} a line that starts with "}": ${which}. `
    + "The game ends a string at such a line and drops the rest of it. Start the line with a space (\" }\") or remove it.";
}

/** Thrown instead of writing a string the game would cut. */
export class WtsCutError extends Error {
  constructor(public cuts: WtsCut[], prefix = "Not saved: ") {
    super(prefix + wtsCutMessage(cuts));
    this.name = "WtsCutError";
  }
}

/** Before a save: asks whether to change the texts that would be cut (` }`). True: the caller changes
 *  them (wtsSafeText) and saves; false: the save stops (the caller throws WtsCutError). Nothing to ask: true. */
export async function askWtsCuts(confirm: (message: string, yes: string, expires: number) => Promise<boolean>, cuts: WtsCut[]): Promise<boolean> {
  if (!cuts.length) return true;
  return confirm(`${wtsCutMessage(cuts)} Change ${cuts.length === 1 ? "it" : "them"} to " }" and save?`, "Change and Save", 120_000);
}

/** Text outside every string of a war3map.wts as written by hand: what follows a block's end before the next
 *  header, other than blank and `//` lines. A `}` line typed inside a text ends the string there, and the
 *  rest of the text lands out here, where nothing reads it. Lines are 1-based. */
export function wtsStrayLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let line = 1, counted = 0; // line of text[counted]
  const lineAt = (i: number) => { for (; counted < i; counted++) if (text.charCodeAt(counted) === 10) line++; return line; };
  const r = new WtsReader(text);
  for (const b of scan(text, r)) {
    // the gap ends at the next header (the next block's, or one this parser couldn't close)
    const h = r.findHeader(b.end);
    const gap = text.slice(b.end, h ? h.at : text.length);
    let at = b.end;
    for (const l of gap.split("\n")) {
      const t = l.trim();
      if (t && !t.startsWith("//")) out.push({ line: lineAt(at), text: t });
      at += l.length + 1;
    }
  }
  return out;
}

export class StringTable {
  private values = new Map<number, string>();
  private changed = new Set<number>();

  constructor(private text: string) {
    for (const b of scan(text)) this.values.set(b.num, text.slice(b.from, b.to));
  }

  /** "TRIGSTR_003" / "TRIGSTR_3" → 3, anything else → null. */
  static ref(value: string): number | null {
    const m = /^TRIGSTR_(\d+)$/.exec(value);
    return m ? Number(m[1]) : null;
  }

  has(n: number) {
    return this.values.has(n);
  }

  get(n: number): string | undefined {
    return this.values.get(n);
  }

  entries(): IterableIterator<[number, string]> {
    return this.values.entries();
  }

  /** The text behind a "TRIGSTR_n" value; other values are returned as they are. */
  resolve(value: string): string {
    const n = StringTable.ref(value);
    return n === null ? value : this.values.get(n) ?? value;
  }

  set(n: number, value: string) {
    if (this.values.get(n) === value) return;
    this.values.set(n, value);
    this.changed.add(n);
  }

  get dirty() {
    return this.changed.size > 0;
  }

  /** The changed strings whose text the game would cut (see wtsCutLines): serialize refuses them. */
  cuts(): WtsCut[] {
    return wtsCuts([...this.changed].filter((n) => this.values.has(n)).map((n) => [n, this.values.get(n)!] as [number, string]));
  }

  /** Changes the texts of `cuts()` so they are read back whole (wtsSafeText); returns their numbers. */
  fixCuts(): number[] {
    const fixed = this.cuts().map((c) => c.num);
    for (const n of fixed) this.set(n, wtsSafeText(this.values.get(n)!));
    return fixed;
  }

  /** The file with changed blocks rewritten. Every write of the string table goes through here, so a
   *  changed text the game would cut is refused (WtsCutError) rather than written and silently cut. */
  serialize(): string {
    const cuts = this.cuts();
    if (cuts.length) throw new WtsCutError(cuts);
    const eol = this.text.includes("\r\n") ? "\r\n" : "\n";
    let out = "", at = 0;
    for (const b of scan(this.text)) {
      if (!this.changed.has(b.num)) continue;
      // an unchanged block stays as it is; a changed one that had no `}` line gets the usual one
      out += this.text.slice(at, b.from) + this.values.get(b.num)!.replace(/\r?\n/g, eol);
      at = b.closed ? b.to : b.end;
      if (!b.closed) out += eol + "}";
    }
    return out + this.text.slice(at);
  }

  markSaved() {
    this.text = this.serialize();
    this.changed.clear();
  }

  /** Reloads the table from `text` (e.g. the file as saved, with other editors' strings). */
  rebase(text: string) {
    this.text = text;
    this.values.clear();
    this.changed.clear();
    for (const b of scan(text)) this.values.set(b.num, text.slice(b.from, b.to));
  }

  /** The file to save when several editors edit it: `current` (the file on disk now, possibly
   *  saved by another editor meanwhile) with only the strings that `edited` changed compared
   *  with `base` (the file as that editor read or last saved it). Writing `edited` as a whole
   *  would undo the other editors' saved strings. */
  static merge(base: string, edited: StringTable, current: string): string {
    const before = new StringTable(base);
    const out = new StringTable(current);
    const same = (a: string | undefined, b: string | undefined) => a?.replace(/\r\n/g, "\n") === b?.replace(/\r\n/g, "\n");
    for (const [n, v] of edited.entries()) {
      if (!same(before.get(n), v) && out.has(n) && !same(out.get(n), v)) out.set(n, v);
    }
    return out.serialize();
  }
}

// ---- Adjust Map String IDs ---------------------------------------------------------------------

/** The World Editor's Adjust Map String IDs: `ids` maps a string's number to its new one. Every number that stays or
 *  goes must end up used once; a number the file doesn't have, a negative or a fractional one is refused. Throws why. */
export function checkStringIds(table: StringTable, ids: ReadonlyMap<number, number>) {
  for (const [from, to] of ids) {
    if (!table.has(from)) throw new Error(`There's no string ${from}.`);
    if (!Number.isSafeInteger(to) || to < 0) throw new Error(`${to} isn't a string ID (a whole number from 0).`);
  }
  const seen = new Map<number, number>();
  for (const [n] of table.entries()) {
    const to = ids.get(n) ?? n;
    const other = seen.get(to);
    if (other !== undefined) throw new Error(`Strings ${other} and ${n} would both be ${to}.`);
    seen.set(to, n);
  }
}

/** The IDs from `start` up in the order of the current numbers (Adjust's renumbering of the whole table): only the
 *  strings whose number changes. */
export function compactStringIds(table: StringTable, start = 1): Map<number, number> {
  const nums = [...table.entries()].map(([n]) => n).sort((a, b) => a - b);
  return new Map(nums.map((n, i) => [n, start + i] as [number, number]).filter(([n, to]) => n !== to));
}

/** war3map.wts with the numbers of its STRING headers changed by `ids` (see checkStringIds); everything else, the
 *  texts and the order included, stays byte for byte. A zero-padded number keeps its width. */
export function renumberWts(text: string, ids: ReadonlyMap<number, number>): string {
  let out = "", at = 0;
  for (const b of scan(text)) {
    const to = ids.get(b.num);
    if (to === undefined || to === b.num) continue;
    const { digits, digitsEnd } = b.head;
    out += text.slice(at, digits) + String(to).padStart(digitsEnd - digits, "0");
    at = digitsEnd;
  }
  return out + text.slice(at);
}

/** A new string block for appendStrings: `text` with "\n" line ends; `comment` a line of its own ("// …") or none. */
export interface NewString { num: number; text: string; comment?: string | null }

/** `text` (a war3map.wts, "" for a new one) with `blocks` added at the end as the World Editor writes them, a blank line
 *  between blocks and the file's line ends (`eol`). Everything before stays byte for byte. The caller makes sure the
 *  numbers are free and the texts would read back whole (wtsCutLines). */
export function appendStrings(text: string, blocks: readonly NewString[], eol: string): string {
  if (!blocks.length) return text;
  let out = text;
  if (out.replace(/^﻿/, "").trim() !== "") {
    if (!out.endsWith("\n")) out += eol;
    if (!/\n[ \t]*\r?\n$/.test(out)) out += eol;
  }
  for (const b of blocks) {
    out += `STRING ${b.num}${eol}${b.comment ? `// ${b.comment}${eol}` : ""}{${eol}${b.text.replace(/\n/g, eol)}${eol}}${eol}${eol}`;
  }
  return out;
}

/** war3map.wts without the blocks of `nums`: each goes from its STRING header up to the next header (or the end of the
 *  file), so the blank line after it goes too. Everything else stays byte for byte. */
export function removeStrings(text: string, nums: ReadonlySet<number>): string {
  if (!nums.size) return text;
  let out = "", at = 0;
  const r = new WtsReader(text);
  for (const b of scan(text, r)) {
    if (!nums.has(b.num)) continue;
    const next = r.findHeader(b.end);
    out += text.slice(at, b.head.at);
    at = next ? next.at : text.length;
  }
  return out + text.slice(at);
}

/** war3map.wts without the strings nothing refers to (`referenced`: every TRIGSTR number the map's files use), as the
 *  World Editor drops them on every save. The strings that stay keep their numbers, comments and order, and the rest
 *  of the file stays byte for byte (the World Editor writes the whole file anew: no comments but its own, numbers in
 *  order). `dropped`: the numbers that went, ascending; none gives `text` itself. Throws rather than give a table in
 *  which a kept string doesn't read back as it was. */
export function pruneStrings(text: string, referenced: ReadonlySet<number>): { text: string; dropped: number[] } {
  const table = new StringTable(text);
  const dropped = [...new Set(scan(text).map((b) => b.num))].filter((n) => !referenced.has(n)).sort((a, b) => a - b);
  if (!dropped.length) return { text, dropped };
  const out = removeStrings(text, new Set(dropped));
  const back = new StringTable(out);
  for (const [n, v] of table.entries()) {
    if (referenced.has(n) && back.get(n) !== v) throw new Error(`string ${n} wouldn't stay as it is; no strings were dropped.`);
  }
  for (const n of dropped) if (back.has(n)) throw new Error(`string ${n} wouldn't go; no strings were dropped.`);
  return { text: out, dropped };
}

/** A text with its TRIGSTR_ references changed by `ids` (JSON, scripts, custom text): a zero-padded number keeps its
 *  width ("TRIGSTR_007" for 7 → 12 becomes "TRIGSTR_012"). Null when nothing in it changes. */
export function renumberStringRefs(text: string, ids: ReadonlyMap<number, number>): string | null {
  let changed = false;
  const out = text.replace(/TRIGSTR_(\d+)/g, (m, d: string) => {
    const to = ids.get(Number(d));
    if (to === undefined || to === Number(d)) return m;
    changed = true;
    return `TRIGSTR_${String(to).padStart(d.length, "0")}`;
  });
  return changed ? out : null;
}

/** Strings from `incoming`, a translation say, put into the map's `current` file by their numbers. Only the
 *  changed blocks are rewritten; numbers the map doesn't have stay out, as nothing would use them. */
export function importStrings(current: string, incoming: string) {
  const table = new StringTable(current), next = new StringTable(incoming);
  let changed = 0, unknown = 0;
  for (const [n, value] of next.entries()) {
    if (!table.has(n)) { unknown++; continue; }
    if (table.get(n)!.replace(/\r\n/g, "\n") === value.replace(/\r\n/g, "\n")) continue;
    table.set(n, value);
    changed++;
  }
  return { text: table.serialize(), changed, unknown };
}
