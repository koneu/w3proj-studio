// Field filters of the object browser: what "gold>100", "hp>=500" or "race=Night_Elf" in the search
// box mean. A value's spaces are written as underscores, as a token ends at a space.

import type { FieldMeta } from "../../lib/objects/metadata";

export const OPS = [">=", "<=", "!=", ">", "<", "=", ":"] as const;
export type Op = (typeof OPS)[number];
export const OP_LABEL: Record<Op, string> = { ">=": "≥", "<=": "≤", "!=": "≠", ">": ">", "<": "<", "=": "=", ":": "contains" };
const TOKEN = /^([^\s<>=!:]+)(>=|<=|!=|>|<|=|:)(.*)$/;

export interface FieldFilter {
  token: string;
  field: FieldMeta | null;
  key: string;
  op: Op;
  value: string;
}

/** Field for a filter key: exact id, then the game's column name ("HP",
 *  "goldcost"), then label without spaces, then the shortest label containing
 *  the key as whole word(s) ("range" → "Attack 1 - Range"), then label
 *  prefix, then label substring. */
export function resolveField(fields: FieldMeta[], key: string): FieldMeta | null {
  const k = key.toLowerCase().replace(/_/g, " ");
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const word = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const byWord = fields.filter((f) => word.test(f.label)).sort((a, b) => a.label.length - b.label.length)[0];
  return (
    fields.find((f) => f.id.toLowerCase() === k) ??
    fields.find((f) => f.field.toLowerCase() === k) ??
    fields.find((f) => compact(f.label) === compact(k)) ??
    byWord ??
    fields.find((f) => f.label.toLowerCase().startsWith(k)) ??
    fields.find((f) => f.label.toLowerCase().includes(k)) ??
    null
  );
}

/** Splits what's typed into filters and plain search words. */
export function parseQuery(text: string, fields: FieldMeta[]): { words: string[]; filters: FieldFilter[] } {
  const words: string[] = [], filters: FieldFilter[] = [];
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const m = TOKEN.exec(token);
    if (m) filters.push({ token, key: m[1], op: m[2] as Op, value: m[3], field: resolveField(fields, m[1]) });
    else words.push(token.toLowerCase());
  }
  return { words, filters };
}

/** A filter's value as it's meant: what the chip shows. */
export const filterValue = (value: string) => value.replace(/_/g, " ");

/** Underscores count as spaces on both sides: the game's own values have them too ("nightelf_a"). */
const comparable = (text: string) => filterValue(text).toLowerCase();

export function compare(actual: string | undefined, op: Op, expected: string): boolean {
  if (actual === undefined) return op === "!=";
  const a = Number(actual), e = Number(expected);
  const numeric = actual.trim() !== "" && expected.trim() !== "" && Number.isFinite(a) && Number.isFinite(e);
  const as = comparable(actual), es = comparable(expected);
  switch (op) {
    case ">": return numeric && a > e;
    case ">=": return numeric && a >= e;
    case "<": return numeric && a < e;
    case "<=": return numeric && a <= e;
    case "=": return numeric ? a === e : as === es;
    case "!=": return numeric ? a !== e : as !== es;
    case ":": return as.includes(es);
  }
}
