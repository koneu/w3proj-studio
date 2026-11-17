// A number typed into a field of a map file: what the field's type can hold, and the word when it can't. A value
// past it is refused (user decision 2026-11-15: refuse, never overflow, wrap or clamp), so nothing changes.

import { FLOAT32_MAX, float32Text, storableFloat32 } from "./float32";

/** The stored types of the map files' number fields. */
export type StoredNumber = "u8" | "i32" | "u32" | "f32";

const RANGE: Record<Exclude<StoredNumber, "f32">, [number, number, string]> = {
  u8: [0, 255, "a whole number from 0 to 255"],
  i32: [-2147483648, 2147483647, "a whole number from -2147483648 to 2147483647"],
  u32: [0, 4294967295, "a whole number from 0 to 4294967295"],
};

/** Whether `v` fits a field of type `kind`. */
export function storable(kind: StoredNumber, v: number): boolean {
  if (kind === "f32") return storableFloat32(v);
  const [min, max] = RANGE[kind];
  return Number.isInteger(v) && v >= min && v <= max;
}

/** What is said of a value a field of type `kind` can't hold. */
export function storableText(kind: StoredNumber, label: string): string {
  return kind === "f32" ? float32Text(label) : `${label} must be ${RANGE[kind][2]}.`;
}

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;
const PLAIN_INTEGER = /^-?\d+$/;

/** A typed number for a field of type `kind`: the value, or why it is refused (empty, not a number, not whole for an
 *  integer field, past the type's range). */
export function typedNumber(kind: StoredNumber, typed: string, label: string): { value: number } | { refused: string } {
  // Plain decimal text only (user decision 2026-11-17): "1e3", "0x10", "+5", " 5 ", ".5", "Infinity" are refused.
  const plain = kind === "f32" ? PLAIN_DECIMAL : PLAIN_INTEGER;
  const v = plain.test(typed) ? Number(typed) + 0 : NaN; // + 0: "-0" is 0
  if (!storable(kind, v)) return { refused: storableText(kind, label) };
  return { value: v };
}

/** Like `typedNumber`, and the value must lie within the editor's own limits `min`..`max` too (a handicap of 50 to 100):
 *  a value outside them is refused as well, never pulled back in. */
export function typedBetween(kind: StoredNumber, typed: string, label: string, limits: { min?: number; max?: number } = {}): { value: number } | { refused: string } {
  const t = typedNumber(kind, typed, label);
  const { min, max } = limits;
  if (min === undefined && max === undefined) return t;
  if ("refused" in t || (min !== undefined && t.value < min) || (max !== undefined && t.value > max)) {
    // One word for every way out: the range the value must lie in is the editor's, within the type's.
    const [lo, hi] = kind === "f32" ? [-FLOAT32_MAX, FLOAT32_MAX] : RANGE[kind];
    const from = Math.max(min ?? lo, lo), to = Math.min(max ?? hi, hi);
    const show = (n: number) => (Math.abs(n) === FLOAT32_MAX ? (n < 0 ? "-3.4e38" : "3.4e38") : String(n));
    return { refused: `${label} must be ${kind === "f32" ? "a number" : "a whole number"} from ${show(from)} to ${show(to)}.` };
  }
  return t;
}
