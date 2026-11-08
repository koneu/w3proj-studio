// war3map.wts (trigger strings): `STRING <n> [// comment] { text }`.
// Edits replace only the text of changed blocks, so the rest of the file
// (comments, order, line endings) stays byte-identical.

const HEADER = /STRING\s+(\d+)\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n/g;
const CLOSE = /\r?\n\}/g;
// A `}` that ends a text line, with the next block's header right after it (blank lines allowed).
const UNCLOSED = /\}(?=\r?\n(?:[ \t]*\r?\n)*STRING\s+\d+\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n)/g;

/** One `STRING n { text }` block: `text.slice(from, to)` is the text, `text.slice(to, end)` what closes it. */
interface Block { num: number; from: number; to: number; end: number; closed: boolean }

/** The blocks of a file. A block ends at the first line that starts with `}`. Some real files have
 *  a block whose `}` sits at the end of its last text line, with the next STRING block right after;
 *  there the first such `}` ends the block (before the next header, never anywhere else), so the next
 *  string isn't swallowed. That also holds when no `}` line follows at all. A last block without a
 *  header after it stays unread, as it is without a `}` line.
 *
 *  The next `}` line and the next unclosed `}` are each searched for once and kept while they still
 *  lie ahead, so a file of many unclosed blocks is read in one pass. */
function scan(text: string): Block[] {
  const blocks: Block[] = [];
  let pos = 0;
  let c: RegExpExecArray | null | undefined, u: RegExpExecArray | null | undefined; // undefined: not searched yet
  for (;;) {
    HEADER.lastIndex = pos;
    const h = HEADER.exec(text);
    if (!h) return blocks;
    const from = h.index + h[0].length;
    if (c === undefined || (c && c.index < from)) { CLOSE.lastIndex = from; c = CLOSE.exec(text); }
    if (u === undefined || (u && u.index < from)) { UNCLOSED.lastIndex = from; u = UNCLOSED.exec(text); }
    if (u && (!c || u.index < c.index)) {
      blocks.push({ num: Number(h[1]), from, to: u.index, end: u.index + 1, closed: false });
      pos = u.index + 1;
    } else if (!c) {
      return blocks;
    } else {
      blocks.push({ num: Number(h[1]), from, to: c.index, end: c.index + c[0].length, closed: true });
      pos = c.index + c[0].length;
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
  for (const b of scan(text)) {
    // the gap ends at the next header (the next block's, or one this parser couldn't close)
    HEADER.lastIndex = b.end;
    const h = HEADER.exec(text);
    const gap = text.slice(b.end, h ? h.index : text.length);
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
