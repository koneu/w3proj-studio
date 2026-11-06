// war3map.wts (trigger strings): `STRING <n> [// comment] { text }`.
// Edits replace only the text of changed blocks, so the rest of the file
// (comments, order, line endings) stays byte-identical.

const BLOCK = /(STRING\s+(\d+)\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n)([\s\S]*?)(\r?\n\})/g;

export class StringTable {
  private values = new Map<number, string>();
  private changed = new Set<number>();

  constructor(private text: string) {
    for (const m of text.matchAll(BLOCK)) this.values.set(Number(m[2]), m[3]);
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
    return this.text.replace(BLOCK, (all, head: string, num: string, _body: string, tail: string) => {
      const n = Number(num);
      if (!this.changed.has(n)) return all;
      return head + this.values.get(n)!.replace(/\r?\n/g, eol) + tail;
    });
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
    for (const m of text.matchAll(BLOCK)) this.values.set(Number(m[2]), m[3]);
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
