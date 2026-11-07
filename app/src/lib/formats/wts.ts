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

  /** The file with changed blocks rewritten. */
  serialize(): string {
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
