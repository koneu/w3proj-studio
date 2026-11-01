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
}
