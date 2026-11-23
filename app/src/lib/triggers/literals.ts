// Typed numbers of GUI triggers (a parameter's Value, a variable's initial value). war3map.wtg keeps them as text and
// the map script takes that text as it is, so a number goes in only in a form the script can hold: an integer is a
// 32-bit whole number in decimal (or 0x hex), a real a 32-bit float written without an exponent. Anything else is
// refused, never wrapped or cut (user decision 2026-11-15).

import { FLOAT32_MAX } from "../formats/float32";

const INT_MIN = -2147483648, INT_MAX = 2147483647;

/** Why `typed` can't be an integer or real literal (`base`), or null when it can. Other types: null. */
export function literalProblem(base: string, typed: string): string | null {
  if (base !== "integer" && base !== "real") return null;
  const t = typed.trim();
  if (base === "integer") {
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      return n < INT_MIN || n > INT_MAX ? `An integer is from ${INT_MIN} to ${INT_MAX}.` : null;
    }
    if (/^0x[0-9a-f]+$/i.test(t)) return Number(t) > INT_MAX ? `An integer is from ${INT_MIN} to ${INT_MAX} (0x7FFFFFFF).` : null;
    if (t !== "" && Number.isFinite(Number(t)) && !/e/i.test(t)) return "Enter a whole number.";
    return "Enter a whole number, like 12 or -3.";
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) {
    return t !== "" && Number.isFinite(Number(t)) ? "Write the number without an exponent, like 1500.0." : "Enter a number, like 1.5.";
  }
  return Math.abs(Number(t)) > FLOAT32_MAX ? "A real is from -3.4e38 to 3.4e38 (a 32-bit float)." : null;
}

/** Whether `typed` is an object code (rawcode: exactly 4 characters, like hfoo) typed for a parameter of a code type
 *  (unitcode, abilcode …). war3map.wtg keeps it as that text, as the object pickers give it, and the map script writes
 *  it as 'hfoo' (an integer underneath), so it isn't read as a number. */
export function isTypedCode(type: string, typed: string): boolean {
  return /code$/.test(type) && /^.{4}$/.test(typed.trim()) && !/['\\]/.test(typed);
}

/** A variable's typed initial value (type `type`, its base type `base`) as war3map.wtg stores it: null for the
 *  default (an empty box, but for strings), or why it is refused. Reals are kept with two decimals (realText). */
export function typedInitialValue(base: string, type: string, typed: string): { value: string | null } | { refused: string } {
  const raw = typed.trim();
  if (raw === "" && base !== "string") return { value: null };
  // Object codes (unitcode and the like) are integers in the script, written as 'hfoo'.
  if (/code$/.test(type)) return /^.{4}$/.test(raw) ? { value: raw } : { refused: "An object code is 4 characters, like hfoo." };
  if (base === "integer") {
    const bad = literalProblem(base, raw);
    return bad ? { refused: bad } : { value: raw };
  }
  if (base === "real") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { refused: "Enter a number, like 1.5." };
    if (Math.abs(n) > FLOAT32_MAX) return { refused: "A real is from -3.4e38 to 3.4e38 (a 32-bit float)." };
    return { value: realText(n) };
  }
  return { value: base === "string" ? (typed === "" ? null : typed) : raw };
}

/** A real with two decimals as the World Editor writes a variable's initial value, without an exponent however large. */
export function realText(n: number): string {
  return Math.abs(n) < 1e21 ? n.toFixed(2) : `${BigInt(n)}.00`;
}

/** The World Editor's limit on a typed Integer or Real value in the trigger editor (a parameter's Value, a variable's
 *  initial value), measured 2026-11-22 (verify ya.md). */
export const TRIGGER_NUMBER_LIMIT = 1e9;

/** What a trigger value box lets through as it is typed: an Integer box takes digits and "-" (so 12.5 is 125), a Real
 *  box digits, "-" and "." (so 1.5e3 is 1.53). Other types: the text as it is. */
export function filterTriggerTyping(base: string, text: string): string {
  if (base === "integer") return text.replace(/[^0-9-]/g, "");
  if (base === "real") return text.replace(/[^0-9.-]/g, "");
  return text;
}

/** The value the World Editor keeps for `typed` in an Integer or Real box (after `filterTriggerTyping`), as the text
 *  war3map.wtg stores: an Integer wraps to 32 bits first, goes through a 32-bit float (123456789 is 123456792) and is
 *  pulled into -1e9..1e9; a Real is pulled into -1e9..1e9 and kept with two decimals (of the float, so 0.005 is 0.00).
 *  Only for what is typed in the editor: a value already in a map is kept as it is, and the MCP tools refuse such values
 *  (typedInitialValue). An empty box is null (the default); text that isn't a number is refused. */
export function typedTriggerNumber(base: "integer" | "real", typed: string): { value: string | null } | { refused: string } {
  const raw = typed.trim();
  if (raw === "") return { value: null };
  const clamp = (n: number) => Math.min(TRIGGER_NUMBER_LIMIT, Math.max(-TRIGGER_NUMBER_LIMIT, n));
  if (base === "integer") {
    if (!/^-?\d+$/.test(raw)) return { refused: "Enter a whole number, like 12 or -3." };
    const wrapped = Number(BigInt.asIntN(32, BigInt(raw)));
    return { value: String(clamp(Math.fround(wrapped)) + 0) };
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(raw)) return { refused: "Enter a number, like 1.5." };
  return { value: Math.fround(clamp(Number(raw))).toFixed(2).replace(/^-0\.00$/, "0.00") };
}
