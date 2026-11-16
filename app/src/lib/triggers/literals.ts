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
