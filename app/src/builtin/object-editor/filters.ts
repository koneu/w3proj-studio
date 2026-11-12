// Field filters of the object browser: what "gold>100", "hp>=500" or "race=Night_Elf" in the search
// box mean. A value's spaces are written as underscores, as a token ends at a space, or the value is quoted
// (race:"Night Elf").

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

/** The field the filter builder's field box names: the suggestion format "Label (id)", a bare label or id, or
 *  "Label id". Nothing typed is no field. */
export function builderField(kd: { fields: FieldMeta[]; fieldById: ReadonlyMap<string, FieldMeta> }, typed: string): FieldMeta | null {
  const text = typed.trim();
  if (!text) return null;
  const m = /\(([^()]+)\)\s*$/.exec(text);
  const lastWord = text.split(/\s+/).pop() ?? "";
  return (m && kd.fieldById.get(m[1])) || kd.fieldById.get(lastWord) || resolveField(kd.fields, text);
}

/** What's typed, split at spaces outside double quotes: `race:"Night Elf"` is one token (a quote left open runs to
 *  the end). The tokens keep their quotes, so a token can be found in the text again (a chip's ×). */
export function tokenize(text: string): string[] {
  return text.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

const unquote = (s: string) => s.replace(/"/g, "");

/** Splits what's typed into filters and plain search words. A value or word in double quotes keeps its spaces. */
export function parseQuery(text: string, fields: FieldMeta[]): { words: string[]; filters: FieldFilter[] } {
  const words: string[] = [], filters: FieldFilter[] = [];
  for (const token of tokenize(text)) {
    const m = TOKEN.exec(token);
    if (m) filters.push({ token, key: m[1], op: m[2] as Op, value: unquote(m[3]), field: resolveField(fields, m[1]) });
    else if (unquote(token)) words.push(unquote(token).toLowerCase());
  }
  return { words, filters };
}

/** The text of one filter as the builder writes it: `race:"Night Elf"` for a value with whitespace, a single word bare.
 *  The query has no way to escape a double quote, so quotes in the value are dropped. */
export function formatFilter(fieldId: string, op: Op, value: string): string {
  const v = value.replace(/"/g, "").trim().replace(/\s+/g, " ");
  return `${fieldId}${op}${/\s/.test(v) ? `"${v}"` : v}`;
}

/** The operator a new filter on the field starts with: an order for numbers, equality for on/off fields, "contains"
 *  for text and choices (a race, a list), where an order finds nothing. */
export function defaultOp(field: Pick<FieldMeta, "type" | "valueType"> | null): Op {
  if (!field) return ":";
  if (field.type === "bool") return "=";
  return ["int", "real", "unreal"].includes(field.type) ? ">=" : ":";
}

/** A filter's value as it's meant: what the chip shows. */
export const filterValue = (value: string) => value.replace(/_/g, " ");

/** Underscores count as spaces on both sides: the game's own values have them too ("nightelf_a"). */
const comparable = (text: string) => filterValue(text).toLowerCase();

/** A field filter on a value: the stored value or, when given, the label it shows (`shown`, see
 *  shownValue: "race:Night_Elf" finds what's stored as "nightelf"). A "≠" holds when neither is equal. */
export function compare(actual: string | undefined, op: Op, expected: string, shown?: string): boolean {
  if (shown === undefined || actual === undefined) return compareText(actual, op, expected);
  if (op === "!=") return compareText(actual, op, expected) && compareText(shown, op, expected);
  return compareText(actual, op, expected) || ((op === "=" || op === ":") && compareText(shown, op, expected));
}

function compareText(actual: string | undefined, op: Op, expected: string): boolean {
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
