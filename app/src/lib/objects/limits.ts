// The ranges the game's metadata tables give number fields (minVal, maxVal). The World Editor keeps
// typed values inside them; here they only warn: the game's own maps go past them (a Movement Speed
// of 1000 against a limit of 522), and a value is always saved as typed.

export interface FieldRange {
  min?: number;
  max?: number;
}

/** The types whose minVal and maxVal are a value's range. On other types they mean something else:
 *  strings and lists use them for lengths and counts, and some hold names. */
const NUMBER_TYPES = new Set(["int", "real", "unreal"]);

const bound = (text: string | undefined) => {
  const n = text === undefined || text.trim() === "" ? NaN : Number(text);
  return Number.isFinite(n) ? n : undefined;
};

/** A field's range, or undefined if it has none. */
export function rangeOf(type: string, minVal: string | undefined, maxVal: string | undefined): FieldRange | undefined {
  if (!NUMBER_TYPES.has(type)) return undefined;
  const min = bound(minVal), max = bound(maxVal);
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
}

/** Whether a value is a number outside the range. */
export function outside(range: FieldRange | undefined, value: number | string): boolean {
  if (!range || value === "") return false;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return (range.min !== undefined && n < range.min) || (range.max !== undefined && n > range.max);
}

/** "0 to 522", "at most 20", "at least 1". */
export function rangeText(range: FieldRange): string {
  if (range.min !== undefined && range.max !== undefined) return `${range.min} to ${range.max}`;
  return range.max !== undefined ? `at most ${range.max}` : `at least ${range.min}`;
}

/** What a number field's tooltip says. */
export function rangeNote(range: FieldRange | undefined, over: boolean): string {
  if (!range) return "";
  return over
    ? `Outside the World Editor's range (${rangeText(range)}). It's saved as typed, but the game may not treat it that way.`
    : `World Editor's range: ${rangeText(range)}`;
}
