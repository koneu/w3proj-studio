// Text formats of the game data: SYLK tables (.slk) and INI-style
// [section] key=value files (.txt), plus World Editor string lookups.

/** SYLK (`.slk`) → rows keyed by the header row's column names. */
export function parseSlk(text: string): Record<string, string>[] {
  const cells = new Map<number, Map<number, string>>();
  let x = 0, y = 0;
  for (const line of text.split(/\r?\n/)) {
    // C (cell) and F (format) records both move the cursor via X/Y.
    if (!line.startsWith("C;") && !line.startsWith("F;")) continue;
    // The value follows ";K" and may itself contain ';'.
    const ki = line.indexOf(";K");
    const head = ki >= 0 ? line.slice(0, ki) : line;
    for (const part of head.split(";").slice(1)) {
      if (part[0] === "X") x = Number(part.slice(1));
      else if (part[0] === "Y") y = Number(part.slice(1));
    }
    if (line.startsWith("C;") && ki >= 0) {
      const raw = line.slice(ki + 2);
      const v = raw.startsWith('"') ? raw.slice(1, raw.endsWith('"') ? -1 : undefined) : raw;
      if (!cells.has(y)) cells.set(y, new Map());
      cells.get(y)!.set(x, v);
    }
  }
  const header = cells.get(1);
  if (!header) return [];
  const rows: Record<string, string>[] = [];
  for (const [row, cols] of [...cells].sort((a, b) => a[0] - b[0])) {
    if (row === 1) continue;
    const r: Record<string, string> = {};
    for (const [col, v] of cols) {
      const name = header.get(col);
      if (name) r[name] = v;
    }
    rows.push(r);
  }
  return rows;
}

/** A value without its surrounding double quotes. */
export const unquote = (v: string) => (v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** INI-style `[section] key=value` text. Keys are lower-cased; values keep
 *  their quotes so comma lists can be split correctly (see `listItem`). A key given twice in a section keeps its last
 *  value, or its first with `firstWins` (as the World Editor reads DestructableSkin.txt's tree bridges). */
export function parseIniRaw(text: string, opts: { firstWins?: boolean } = {}): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let cur: Map<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      const name = line.slice(1, line.indexOf("]"));
      cur = out.get(name) ?? new Map();
      out.set(name, cur);
    } else if (cur && !line.startsWith("//")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim().toLowerCase();
      if (!opts.firstWins || !cur.has(key)) cur.set(key, line.slice(eq + 1).trim());
    }
  }
  return out;
}

/** Same as parseIniRaw but with surrounding quotes removed. */
export function parseIni(text: string, opts: { firstWins?: boolean } = {}): Map<string, Map<string, string>> {
  const raw = parseIniRaw(text, opts);
  for (const section of raw.values()) for (const [k, v] of section) section.set(k, unquote(v));
  return raw;
}

/** Item `i` of a comma list where items may be quoted ("a, b",c). */
export function listItem(raw: string, i: number): string | undefined {
  const items: string[] = [];
  let cur = "", quoted = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { items.push(cur); cur = ""; }
    else cur += ch;
  }
  items.push(cur);
  return items[i];
}

/** A World Editor string by key (`strings`: upper-case keys, from WorldEditStrings/WorldEditGameStrings). An entry can
 *  name another (WESTRING_UE_UNITRACE_HUMAN=WESTRING_RACE_HUMAN, WESTRING_TRIGTYPE_attacktype=WESTRING_COD_TYPE_…):
 *  followed up to 4 steps, so a loop in the file can't hang; a step to a missing key stops at the name. undefined
 *  when `key` itself isn't there. */
export function lookupWestring(strings: ReadonlyMap<string, string>, key: string): string | undefined {
  let v = strings.get(key.toUpperCase());
  if (v === undefined) return undefined;
  for (let i = 0; i < 4 && v.startsWith("WESTRING_"); i++) {
    const next = strings.get(v.toUpperCase());
    if (next === undefined) break;
    v = next;
  }
  return v;
}

export function westring(we: ReadonlyMap<string, string>, s: string): string {
  const v = s.startsWith("WESTRING_") ? lookupWestring(we, s) ?? s : s;
  // Some labels come twice, the second with its hotkey ("Air,&Air", "Ground, &Ground").
  return v.replace(/&/g, "").replace(/^(.+?),\s*\1$/, "$1");
}
